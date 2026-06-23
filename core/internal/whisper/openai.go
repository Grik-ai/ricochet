package whisper

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// OpenAICloudTranscriber uses OpenAI API for transcription
type OpenAICloudTranscriber struct {
	apiKey string
}

func NewOpenAICloudTranscriber(apiKey string) *OpenAICloudTranscriber {
	return &OpenAICloudTranscriber{apiKey: apiKey}
}

func (t *OpenAICloudTranscriber) Transcribe(path string) (string, error) {
	if t.apiKey == "" {
		return "", fmt.Errorf("OpenAI API key is not set")
	}
	audioPath, cleanup, err := prepareOpenAIAudio(path)
	if err != nil {
		return "", err
	}
	defer cleanup()

	model := os.Getenv("OPENAI_TRANSCRIBE_MODEL")
	if model == "" {
		model = "gpt-4o-mini-transcribe"
	}
	text, err := t.transcribeWithModel(audioPath, model)
	if err == nil || model == "whisper-1" {
		return text, err
	}
	return t.transcribeWithModel(audioPath, "whisper-1")
}

func (t *OpenAICloudTranscriber) transcribeWithModel(path, model string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", filepath.Base(path))
	if err != nil {
		return "", err
	}
	if _, err = io.Copy(part, file); err != nil {
		return "", err
	}

	writer.WriteField("model", model)
	writer.Close()

	req, err := http.NewRequest("POST", "https://api.openai.com/v1/audio/transcriptions", body)
	if err != nil {
		return "", err
	}

	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+t.apiKey)

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("OpenAI transcription failed (%d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}

	return result.Text, nil
}

func prepareOpenAIAudio(path string) (string, func(), error) {
	cleanup := func() {}
	if strings.ToLower(filepath.Ext(path)) != ".ogg" {
		return path, cleanup, nil
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return path, cleanup, nil
	}
	tmp, err := os.CreateTemp("", "ricochet-openai-audio-*.wav")
	if err != nil {
		return "", cleanup, err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	cmd := exec.Command(ffmpeg, "-y", "-i", path, "-ar", "16000", "-ac", "1", tmpPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		_ = os.Remove(tmpPath)
		return "", cleanup, fmt.Errorf("ffmpeg transcode failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return tmpPath, func() { _ = os.Remove(tmpPath) }, nil
}
