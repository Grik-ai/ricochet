package server

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestAudioStopRequiresLocalWhisperSettings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	h := &Handler{}
	writer := &captureWriter{}
	h.HandleMessage(protocol.RPCMessage{ID: 1, Type: "audio_start", Payload: protocol.EncodeRPC(map[string]string{})}, writer)
	h.HandleMessage(protocol.RPCMessage{
		ID:      2,
		Type:    "audio_chunk",
		Payload: protocol.EncodeRPC(map[string]string{"data": base64.StdEncoding.EncodeToString([]byte("voice"))}),
	}, writer)
	h.HandleMessage(protocol.RPCMessage{ID: 3, Type: "audio_stop", Payload: protocol.EncodeRPC(map[string]string{})}, writer)

	result := decodeAudioResult(t, writer.messages[len(writer.messages)-1])
	if result.OK {
		t.Fatalf("audio result OK = true, want setup error")
	}
	if result.Error == "" || !contains(result.Error, "Whisper") {
		t.Fatalf("audio error = %q, want Whisper setup message", result.Error)
	}
	if result.Phase != "setup" || result.Retryable {
		t.Fatalf("audio setup classification = phase %q retryable %v, want setup/non-retryable", result.Phase, result.Retryable)
	}
}

func TestAudioChunksTranscribeInOrderWithLocalWhisper(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	toolsDir := t.TempDir()
	ffmpegPath := filepath.Join(toolsDir, "ffmpeg")
	whisperPath := filepath.Join(toolsDir, "whisper-cli")
	writeExecutable(t, ffmpegPath, `#!/bin/sh
in=""
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-i" ]; then in="$arg"; fi
  out="$arg"
  prev="$arg"
done
cp "$in" "$out"
`)
	writeExecutable(t, whisperPath, `#!/bin/sh
file=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-f" ]; then file="$arg"; fi
  prev="$arg"
done
cat "$file"
`)
	t.Setenv("PATH", toolsDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	settings, err := config.NewStore()
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := settings.Update(func(s *config.Settings) {
		s.LiveMode.WhisperBinary = whisperPath
		s.LiveMode.WhisperModel = filepath.Join(toolsDir, "model.bin")
	}); err != nil {
		t.Fatalf("Update settings: %v", err)
	}

	h := &Handler{Settings: settings}
	writer := &captureWriter{}
	h.HandleMessage(protocol.RPCMessage{ID: 1, Type: "audio_start", Payload: protocol.EncodeRPC(map[string]string{})}, writer)
	h.HandleMessage(protocol.RPCMessage{
		ID:      2,
		Type:    "audio_chunk",
		Payload: protocol.EncodeRPC(map[string]string{"data": base64.StdEncoding.EncodeToString([]byte("first "))}),
	}, writer)
	h.HandleMessage(protocol.RPCMessage{
		ID:      3,
		Type:    "audio_chunk",
		Payload: protocol.EncodeRPC(map[string]string{"data": base64.StdEncoding.EncodeToString([]byte("second"))}),
	}, writer)
	h.HandleMessage(protocol.RPCMessage{ID: 4, Type: "audio_stop", Payload: protocol.EncodeRPC(map[string]string{})}, writer)

	result := decodeAudioResult(t, writer.messages[len(writer.messages)-1])
	if !result.OK {
		t.Fatalf("audio result OK = false: %s", result.Error)
	}
	if result.Text != "first second" {
		t.Fatalf("transcript = %q, want chunk order preserved", result.Text)
	}

	h.HandleMessage(protocol.RPCMessage{ID: 5, Type: "audio_stop", Payload: protocol.EncodeRPC(map[string]string{})}, writer)
	empty := decodeAudioResult(t, writer.messages[len(writer.messages)-1])
	if empty.OK || !contains(empty.Error, "No audio") {
		t.Fatalf("second stop result = %#v, want cleared buffer", empty)
	}
	if empty.Phase != "recording" || empty.Retryable {
		t.Fatalf("empty audio classification = phase %q retryable %v, want recording/non-retryable", empty.Phase, empty.Retryable)
	}
}

func TestAudioChunkRejectsInvalidAndOversizedPayloads(t *testing.T) {
	h := &Handler{}
	writer := &captureWriter{}

	h.HandleMessage(protocol.RPCMessage{ID: 1, Type: "audio_chunk", Payload: protocol.EncodeRPC(map[string]string{"data": "not base64"})}, writer)
	if writer.messages[len(writer.messages)-1].Error == "" {
		t.Fatal("invalid base64 chunk did not return an error")
	}

	h.AudioBuffer = make([]byte, maxWebviewAudioBytes)
	h.HandleMessage(protocol.RPCMessage{
		ID:      2,
		Type:    "audio_chunk",
		Payload: protocol.EncodeRPC(map[string]string{"data": base64.StdEncoding.EncodeToString([]byte("x"))}),
	}, writer)
	if writer.messages[len(writer.messages)-1].Error == "" {
		t.Fatal("oversized audio chunk did not return an error")
	}
	if len(h.AudioBuffer) != 0 {
		t.Fatal("oversized audio did not clear the buffer")
	}
}

func decodeAudioResult(t *testing.T, msg protocol.RPCMessage) audioTranscriptionResult {
	t.Helper()
	if msg.Type != "audio_transcription_result" {
		t.Fatalf("message type = %q, want audio_transcription_result", msg.Type)
	}
	var result audioTranscriptionResult
	if err := json.Unmarshal(msg.Payload, &result); err != nil {
		t.Fatalf("decode audio result: %v", err)
	}
	return result
}

func writeExecutable(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0755); err != nil {
		t.Fatalf("write executable %s: %v", path, err)
	}
}

func contains(s, needle string) bool {
	return strings.Contains(s, needle)
}
