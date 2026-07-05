package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/whisper"
)

const maxWebviewAudioBytes = 25 * 1024 * 1024

type audioTranscriptionResult struct {
	OK        bool   `json:"ok"`
	Text      string `json:"text,omitempty"`
	Error     string `json:"error,omitempty"`
	Phase     string `json:"phase,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
}

func (h *Handler) handleAudioStart(msg protocol.RPCMessage, writer ResponseWriter) {
	h.AudioMu.Lock()
	h.AudioBuffer = nil
	h.AudioMu.Unlock()

	writer.Send(protocol.RPCMessage{
		ID:      msg.ID,
		Type:    "response",
		Payload: protocol.EncodeRPC(map[string]bool{"ok": true}),
	})
}

func (h *Handler) handleAudioChunk(msg protocol.RPCMessage, writer ResponseWriter) {
	var payload struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid audio chunk payload: " + err.Error()})
		return
	}
	chunk, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid audio chunk encoding: " + err.Error()})
		return
	}
	if len(chunk) == 0 {
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "response", Payload: protocol.EncodeRPC(map[string]bool{"ok": true})})
		return
	}

	h.AudioMu.Lock()
	defer h.AudioMu.Unlock()
	if len(h.AudioBuffer)+len(chunk) > maxWebviewAudioBytes {
		h.AudioBuffer = nil
		writer.Send(protocol.RPCMessage{ID: msg.ID, Error: fmt.Sprintf("Audio recording is larger than %d MB.", maxWebviewAudioBytes/1024/1024)})
		return
	}
	h.AudioBuffer = append(h.AudioBuffer, chunk...)
	writer.Send(protocol.RPCMessage{
		ID:      msg.ID,
		Type:    "response",
		Payload: protocol.EncodeRPC(map[string]bool{"ok": true}),
	})
}

func (h *Handler) handleAudioStop(msg protocol.RPCMessage, writer ResponseWriter) {
	h.AudioMu.Lock()
	audio := append([]byte(nil), h.AudioBuffer...)
	h.AudioBuffer = nil
	h.AudioMu.Unlock()

	result := h.transcribeWebviewAudio(audio)
	writer.Send(protocol.RPCMessage{
		ID:      msg.ID,
		Type:    "audio_transcription_result",
		Payload: protocol.EncodeRPC(result),
	})
}

func (h *Handler) transcribeWebviewAudio(audio []byte) audioTranscriptionResult {
	if len(audio) == 0 {
		return audioTranscriptionResult{OK: false, Error: "No audio was captured.", Phase: "recording"}
	}

	transcriber, err := h.ensureWebviewTranscriber()
	if err != nil {
		return audioTranscriptionResult{OK: false, Error: err.Error(), Phase: "setup"}
	}

	tmpDir := paths.GetTmpDir()
	if err := paths.EnsureDir(tmpDir); err != nil {
		return audioTranscriptionResult{OK: false, Error: "Failed to prepare audio temp directory: " + err.Error(), Phase: "recording"}
	}
	tmp, err := os.CreateTemp(tmpDir, "ricochet-webview-audio-*.webm")
	if err != nil {
		return audioTranscriptionResult{OK: false, Error: "Failed to create audio temp file: " + err.Error(), Phase: "recording"}
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(audio); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return audioTranscriptionResult{OK: false, Error: "Failed to save audio: " + err.Error(), Phase: "recording"}
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return audioTranscriptionResult{OK: false, Error: "Failed to close audio file: " + err.Error(), Phase: "recording"}
	}
	defer os.Remove(tmpPath)

	text, err := transcriber.Transcribe(tmpPath)
	if err != nil {
		phase, retryable := classifyWebviewTranscriptionError(err)
		return audioTranscriptionResult{OK: false, Error: err.Error(), Phase: phase, Retryable: retryable}
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return audioTranscriptionResult{OK: false, Error: "No speech was detected.", Phase: "transcription", Retryable: true}
	}
	return audioTranscriptionResult{OK: true, Text: text}
}

func classifyWebviewTranscriptionError(err error) (string, bool) {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "executable file not found") ||
		strings.Contains(message, "no such file or directory") ||
		strings.Contains(message, "permission denied") {
		return "setup", false
	}
	return "transcription", true
}

func (h *Handler) ensureWebviewTranscriber() (*whisper.Transcriber, error) {
	if h.Transcriber != nil {
		return h.Transcriber, nil
	}
	whisperBinary, whisperModel := h.currentWhisperSettings()
	if whisperBinary == "" || whisperModel == "" {
		return nil, fmt.Errorf("Voice input requires local Whisper setup. Set Whisper binary and Whisper model in Settings > Integrations.")
	}
	transcriber, err := whisper.NewTranscriber(whisperBinary, whisperModel)
	if err != nil {
		return nil, err
	}
	h.Transcriber = transcriber
	return transcriber, nil
}

func (h *Handler) currentWhisperSettings() (string, string) {
	if h.Settings != nil {
		live := h.Settings.Get().LiveMode
		if strings.TrimSpace(live.WhisperBinary) != "" || strings.TrimSpace(live.WhisperModel) != "" {
			return strings.TrimSpace(live.WhisperBinary), strings.TrimSpace(live.WhisperModel)
		}
	}
	if h.LiveModeConfig != nil {
		return strings.TrimSpace(h.LiveModeConfig.WhisperBinary), strings.TrimSpace(h.LiveModeConfig.WhisperModel)
	}
	return "", ""
}
