import { useState, useRef, useCallback, useEffect } from 'react';
import { useVSCodeApi } from './useVSCodeApi';

export type AudioRecordingState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error';

export interface AudioTranscriptResult {
    id: number;
    text: string;
}

export type AudioErrorPhase = 'startup' | 'permission' | 'unsupported' | 'recording' | 'transcription' | 'setup';

export interface AudioRecordingError {
    phase: AudioErrorPhase;
    message: string;
    retryable: boolean;
}

const PREFERRED_AUDIO_MIME_TYPES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
];

const MICROPHONE_PERMISSION_TIMEOUT_MS = 12000;

export function selectAudioMimeType(recorderCtor?: Pick<typeof MediaRecorder, 'isTypeSupported'> | null): string | undefined {
    if (!recorderCtor?.isTypeSupported) return undefined;
    return PREFERRED_AUDIO_MIME_TYPES.find(type => {
        try {
            return recorderCtor.isTypeSupported(type);
        } catch {
            return false;
        }
    });
}

export function microphoneStartErrorMessage(error: unknown): string {
    const name = typeof error === 'object' && error && 'name' in error ? String((error as { name?: unknown }).name || '') : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return 'Microphone permission was denied.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return 'No microphone was found.';
    }
    if (error instanceof Error && error.message) return error.message;
    return 'Failed to start microphone recording.';
}

export function microphoneStartErrorPhase(error: unknown): AudioErrorPhase {
    const name = typeof error === 'object' && error && 'name' in error ? String((error as { name?: unknown }).name || '') : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'startup';
    return 'startup';
}

export function buildAudioRecordingError(
    phase: AudioErrorPhase,
    message: string,
    retryable = phase === 'transcription'
): AudioRecordingError {
    return { phase, message, retryable };
}

export function normalizeAudioResultError(payload: { error?: string; phase?: string; retryable?: boolean }): AudioRecordingError {
    const message = payload.error || 'No speech was detected.';
    const phase = isAudioErrorPhase(payload.phase)
        ? payload.phase
        : /whisper|voice input requires|settings/i.test(message)
            ? 'setup'
            : 'transcription';
    return buildAudioRecordingError(phase, message, payload.retryable ?? phase === 'transcription');
}

function isAudioErrorPhase(value: unknown): value is AudioErrorPhase {
    return value === 'startup'
        || value === 'permission'
        || value === 'unsupported'
        || value === 'recording'
        || value === 'transcription'
        || value === 'setup';
}

/**
 * Hook to record audio from the microphone and send chunks to the Extension.
 * Uses MediaRecorder with Opus codec.
 */
export function useAudioRecorder() {
    const { postMessage, onMessage } = useVSCodeApi();
    const [isRecording, setIsRecording] = useState(false);
    const [audioState, setAudioState] = useState<AudioRecordingState>('idle');
    const [audioError, setAudioError] = useState<AudioRecordingError | null>(null);
    const [lastTranscript, setLastTranscript] = useState<AudioTranscriptResult | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const transcriptIdRef = useRef(0);
    const pendingAudioReadsRef = useRef(0);
    const stopRequestedRef = useRef(false);
    const recordingAttemptRef = useRef(0);
    const permissionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearPermissionTimeout = useCallback(() => {
        if (!permissionTimeoutRef.current) return;
        clearTimeout(permissionTimeoutRef.current);
        permissionTimeoutRef.current = null;
    }, []);

    const stopStream = useCallback(() => {
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }, []);

    const failRecording = useCallback((error: AudioRecordingError) => {
        clearPermissionTimeout();
        stopStream();
        mediaRecorderRef.current = null;
        pendingAudioReadsRef.current = 0;
        stopRequestedRef.current = false;
        setIsRecording(false);
        setAudioState('error');
        setAudioError(error);
    }, [clearPermissionTimeout, stopStream]);

    const postAudioStopWhenReady = useCallback(() => {
        if (!stopRequestedRef.current || pendingAudioReadsRef.current > 0) return;
        stopRequestedRef.current = false;
        postMessage({ type: 'audio_stop' });
    }, [postMessage]);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            if (message.type === 'audio_recording_status') {
                const payload = (message.payload || {}) as { state?: string; phase?: string; message?: string; error?: string; retryable?: boolean };
                if (payload.state === 'error') {
                    failRecording(normalizeAudioResultError({
                        error: payload.message || payload.error || 'Audio recording failed.',
                        phase: payload.phase,
                        retryable: payload.retryable ?? false,
                    }));
                }
                return;
            }
            if (message.type !== 'audio_transcription_result') return;
            const payload = (message.payload || {}) as { ok?: boolean; text?: string; error?: string; phase?: string; retryable?: boolean };
            if (payload.ok && typeof payload.text === 'string' && payload.text.trim()) {
                transcriptIdRef.current += 1;
                setLastTranscript({ id: transcriptIdRef.current, text: payload.text.trim() });
                setAudioState('idle');
                setAudioError(null);
                return;
            }
            setAudioState('error');
            setAudioError(normalizeAudioResultError(payload));
        });
        return () => { unsubscribe(); };
    }, [failRecording, onMessage]);

    useEffect(() => {
        return () => clearPermissionTimeout();
    }, [clearPermissionTimeout]);

    const startRecording = useCallback(async () => {
        if (audioState === 'requesting' || audioState === 'transcribing') return;
        if (!navigator.mediaDevices?.getUserMedia) {
            failRecording(buildAudioRecordingError('unsupported', 'Microphone is not available in this webview.', false));
            return;
        }
        if (typeof MediaRecorder === 'undefined') {
            failRecording(buildAudioRecordingError('unsupported', 'Audio recording is not supported in this webview.', false));
            return;
        }

        recordingAttemptRef.current += 1;
        const attemptId = recordingAttemptRef.current;
        try {
            setIsRecording(false);
            setAudioState('requesting');
            setAudioError(null);
            clearPermissionTimeout();
            permissionTimeoutRef.current = setTimeout(() => {
                if (recordingAttemptRef.current !== attemptId) return;
                recordingAttemptRef.current += 1;
                failRecording(buildAudioRecordingError(
                    'permission',
                    'Microphone permission is still waiting. Check the VS Code or browser permission prompt.',
                    false
                ));
            }, MICROPHONE_PERMISSION_TIMEOUT_MS);
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (recordingAttemptRef.current !== attemptId) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            clearPermissionTimeout();
            streamRef.current = stream;

            const mimeType = selectAudioMimeType(MediaRecorder);
            const mediaRecorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;

            mediaRecorder.ondataavailable = async (e) => {
                if (e.data.size > 0) {
                    pendingAudioReadsRef.current += 1;
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const result = typeof reader.result === 'string' ? reader.result : '';
                        const base64data = result.split(',')[1];
                        if (base64data) {
                            postMessage({
                                type: 'audio_chunk',
                                payload: {
                                    data: base64data,
                                    format: 'webm',
                                    mimeType: e.data.type || mimeType || ''
                                }
                            });
                        }
                        pendingAudioReadsRef.current = Math.max(0, pendingAudioReadsRef.current - 1);
                        postAudioStopWhenReady();
                    };
                    reader.onerror = () => {
                        failRecording(buildAudioRecordingError('recording', 'Failed to read recorded audio.', false));
                    };
                    reader.readAsDataURL(e.data);
                }
            };
            mediaRecorder.onerror = () => {
                failRecording(buildAudioRecordingError('recording', 'Microphone recording failed.', false));
            };
            mediaRecorder.onstop = () => {
                stopStream();
                mediaRecorderRef.current = null;
                setIsRecording(false);
                setAudioState('transcribing');
                stopRequestedRef.current = true;
                postAudioStopWhenReady();
            };

            pendingAudioReadsRef.current = 0;
            stopRequestedRef.current = false;
            postMessage({ type: 'audio_start', payload: { format: 'webm', mimeType: mimeType || '' } });
            mediaRecorder.start(500);
            setIsRecording(true);
            setAudioState('recording');
            setAudioError(null);
        } catch (err) {
            if (recordingAttemptRef.current !== attemptId) return;
            failRecording(buildAudioRecordingError(microphoneStartErrorPhase(err), microphoneStartErrorMessage(err), false));
        }
    }, [audioState, clearPermissionTimeout, failRecording, postAudioStopWhenReady, postMessage, stopStream]);

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
            return;
        }
        stopStream();
        setIsRecording(false);
        if (audioState === 'recording') {
            setAudioState('idle');
        }
    }, [audioState, stopStream]);

    const toggleRecording = useCallback(() => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    }, [isRecording, startRecording, stopRecording]);

    const resetTranscript = useCallback(() => {
        setLastTranscript(null);
    }, []);

    return {
        isRecording,
        isRequesting: audioState === 'requesting',
        isTranscribing: audioState === 'transcribing',
        audioState,
        audioError,
        lastTranscript,
        resetTranscript,
        startRecording,
        stopRecording,
        toggleRecording
    };
}
