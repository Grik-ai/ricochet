package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func (e *NativeExecutor) GetDiagnostics(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	abspath, err := e.resolvePath(ctx, payload.Path)
	if err != nil {
		return "", err
	}

	// Send request to Host (VS Code Extension)
	resp, err := e.host.SendRequest("get_diagnostics", map[string]string{
		"path": abspath,
	})
	if err != nil {
		return "", fmt.Errorf("lsp request failed: %w", err)
	}

	// Unmarshal response
	var diagnostics []protocol.Diagnostic
	respBytes, _ := json.Marshal(resp) // Re-marshal interface{} or RawMessage
	if err := json.Unmarshal(respBytes, &diagnostics); err != nil {
		return "", fmt.Errorf("failed to parse diagnostics: %w", err)
	}

	if len(diagnostics) == 0 {
		return "No errors or warnings found.", nil
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Diagnostics for %s:\n", payload.Path))
	for _, d := range diagnostics {
		icon := "⚠️"
		switch d.Severity {
		case "Error":
			icon = "❌"
		case "Information":
			icon = "ℹ️"
		}
		sb.WriteString(fmt.Sprintf("%s Line %d: [%s] %s\n", icon, d.Line, d.Severity, d.Message))
	}
	return sb.String(), nil
}

func (e *NativeExecutor) GetDefinitionsLSP(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path      string `json:"path"`
		Line      int    `json:"line"`
		Character int    `json:"character"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	abspath, err := e.resolvePath(ctx, payload.Path)
	if err != nil {
		return "", err
	}

	// Send request to Host (VS Code Extension)
	resp, err := e.host.SendRequest("get_definitions", map[string]interface{}{
		"path":      abspath,
		"line":      payload.Line,
		"character": payload.Character,
	})
	if err != nil {
		return "", fmt.Errorf("lsp request failed: %w", err)
	}

	// Unmarshal response
	var locations []protocol.DefinitionLocation
	respBytes, _ := json.Marshal(resp)
	if err := json.Unmarshal(respBytes, &locations); err != nil {
		return "", fmt.Errorf("failed to parse definitions: %w", err)
	}

	if len(locations) == 0 {
		return "No definition found.", nil
	}

	var sb strings.Builder
	for _, loc := range locations {
		sb.WriteString(fmt.Sprintf("- %s:%d-%d\n", loc.File, loc.StartLine, loc.EndLine))
	}
	return sb.String(), nil
}
func (e *NativeExecutor) GetReferencesLSP(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path      string `json:"path"`
		Line      int    `json:"line"`
		Character int    `json:"character"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	abspath, err := e.resolvePath(ctx, payload.Path)
	if err != nil {
		return "", err
	}

	resp, err := e.host.SendRequest("get_references", map[string]interface{}{
		"path":      abspath,
		"line":      payload.Line,
		"character": payload.Character,
	})
	if err != nil {
		return "", fmt.Errorf("lsp request failed: %w", err)
	}

	var locations []protocol.DefinitionLocation
	respBytes, _ := json.Marshal(resp)
	if err := json.Unmarshal(respBytes, &locations); err != nil {
		return "", fmt.Errorf("failed to parse references: %w", err)
	}

	if len(locations) == 0 {
		return "No references found.", nil
	}

	var sb strings.Builder
	for _, loc := range locations {
		sb.WriteString(fmt.Sprintf("- %s:%d-%d\n", loc.File, loc.StartLine, loc.EndLine))
	}
	return sb.String(), nil
}

func (e *NativeExecutor) GetSymbolsLSP(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	abspath, err := e.resolvePath(ctx, payload.Path)
	if err != nil {
		return "", err
	}

	resp, err := e.host.SendRequest("get_symbols", map[string]string{
		"path": abspath,
	})
	if err != nil {
		return "", fmt.Errorf("lsp request failed: %w", err)
	}

	respBytes, _ := json.Marshal(resp)
	return string(respBytes), nil // Return raw JSON for the agent to parse symbols
}

func (e *NativeExecutor) GetImplementationsLSP(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path      string `json:"path"`
		Line      int    `json:"line"`
		Character int    `json:"character"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	abspath, err := e.resolvePath(ctx, payload.Path)
	if err != nil {
		return "", err
	}

	resp, err := e.host.SendRequest("get_implementations", map[string]interface{}{
		"path":      abspath,
		"line":      payload.Line,
		"character": payload.Character,
	})
	if err != nil {
		return "", fmt.Errorf("lsp request failed: %w", err)
	}

	var locations []protocol.DefinitionLocation
	respBytes, _ := json.Marshal(resp)
	if err := json.Unmarshal(respBytes, &locations); err != nil {
		return "", fmt.Errorf("failed to parse implementations: %w", err)
	}

	if len(locations) == 0 {
		return "No implementations found.", nil
	}

	var sb strings.Builder
	for _, loc := range locations {
		sb.WriteString(fmt.Sprintf("- %s:%d-%d\n", loc.File, loc.StartLine, loc.EndLine))
	}
	return sb.String(), nil
}
