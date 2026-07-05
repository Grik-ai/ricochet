package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestBuildContextFileAttachmentContextAddsBoundedWorkspaceFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Project\nimportant context"), 0600); err != nil {
		t.Fatal(err)
	}
	controller := &Controller{cwd: dir}

	section := controller.buildContextFileAttachmentContext("please inspect", []protocol.ContextFileAttachment{{Path: "README.md", Name: "README.md"}})
	if !strings.Contains(section, "Attached Files") {
		t.Fatalf("expected attachment section, got %s", section)
	}
	if !strings.Contains(section, "important context") {
		t.Fatalf("expected file preview, got %s", section)
	}
}

func TestBuildContextFileAttachmentContextSkipsIgnoredFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".ricochetignore"), []byte("secret.txt\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("token"), 0600); err != nil {
		t.Fatal(err)
	}
	controller := &Controller{cwd: dir}

	section := controller.buildContextFileAttachmentContext("Context Files:\n@secret.txt", nil)
	if strings.Contains(section, "token") {
		t.Fatalf("ignored content leaked into section: %s", section)
	}
	if !strings.Contains(section, ".ricochetignore") {
		t.Fatalf("expected ignore warning, got %s", section)
	}
}

func TestBuildContextFileAttachmentContextReadsStagedAttachmentDespiteGitIgnore(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(".ricochet/\n"), 0600); err != nil {
		t.Fatal(err)
	}
	attachmentDir := filepath.Join(dir, ".ricochet", "attachments", "session-1")
	if err := os.MkdirAll(attachmentDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(attachmentDir, "notes.txt"), []byte("pasted attachment context"), 0600); err != nil {
		t.Fatal(err)
	}
	controller := &Controller{cwd: dir}

	section := controller.buildContextFileAttachmentContext("please inspect", []protocol.ContextFileAttachment{{
		Path:   ".ricochet/attachments/session-1/notes.txt",
		Name:   "notes.txt",
		Kind:   "attachment",
		Source: "attachment",
	}})

	if !strings.Contains(section, "pasted attachment context") {
		t.Fatalf("expected staged attachment preview, got %s", section)
	}
	if strings.Contains(section, "blocked by .gitignore") {
		t.Fatalf("staged attachment should bypass workspace .gitignore warning, got %s", section)
	}
}

func TestBuildContextFileAttachmentContextCreatesManifestForMixedAttachments(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", t.TempDir())
	t.Setenv("RICOCHET_DISABLE_ATTACHMENT_TOOL_FALLBACK", "1")
	attachmentDir := filepath.Join(dir, ".ricochet", "attachments", "session-1")
	if err := os.MkdirAll(attachmentDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(attachmentDir, "invoice.pdf"), []byte("%PDF-1.7\nSECRET_PDF_TEXT"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(attachmentDir, "screen.png"), []byte("PNG_SECRET_BYTES"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(attachmentDir, "prices.csv"), []byte("sku,price\narena,12"), 0600); err != nil {
		t.Fatal(err)
	}
	controller := &Controller{cwd: dir}

	section := controller.buildContextFileAttachmentContext("please inspect", []protocol.ContextFileAttachment{
		{
			Path:   ".ricochet/attachments/session-1/invoice.pdf",
			Name:   "invoice.pdf",
			Kind:   "attachment",
			Source: "attachment",
			Mime:   "application/pdf",
		},
		{
			Path:   ".ricochet/attachments/session-1/screen.png",
			Name:   "screen.png",
			Kind:   "attachment",
			Source: "attachment",
			Mime:   "image/png",
		},
		{
			Path:   ".ricochet/attachments/session-1/prices.csv",
			Name:   "prices.csv",
			Kind:   "attachment",
			Source: "attachment",
			Mime:   "text/csv",
		},
	})

	if strings.Contains(section, "SECRET_PDF_TEXT") || strings.Contains(section, "PNG_SECRET_BYTES") {
		t.Fatalf("unsupported binary attachment content leaked into section: %s", section)
	}
	for _, want := range []string{"invoice.pdf", "screen.png", "prices.csv", "status: needs_pdf_parse", "status: needs_ocr", "status: included_text", "sku,price"} {
		if !strings.Contains(section, want) {
			t.Fatalf("expected %q in mixed attachment section, got %s", want, section)
		}
	}
	if !strings.Contains(section, "pdftotext is not installed") {
		t.Fatalf("expected PDF parser warning, got %s", section)
	}
	if !strings.Contains(section, "tesseract OCR is not installed") {
		t.Fatalf("expected OCR warning, got %s", section)
	}
}

func TestBuildContextFileAttachmentContextExtractsPDFWithPdftotext(t *testing.T) {
	dir := t.TempDir()
	binDir := t.TempDir()
	writeFakeCommand(t, binDir, "pdftotext", "printf 'PDF extracted text from local parser'")
	t.Setenv("PATH", binDir)
	attachmentDir := filepath.Join(dir, ".ricochet", "attachments", "session-1")
	if err := os.MkdirAll(attachmentDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(attachmentDir, "invoice.pdf"), []byte("%PDF-1.7"), 0600); err != nil {
		t.Fatal(err)
	}
	controller := &Controller{cwd: dir}

	section := controller.buildContextFileAttachmentContext("please inspect", []protocol.ContextFileAttachment{{
		Path:   ".ricochet/attachments/session-1/invoice.pdf",
		Name:   "invoice.pdf",
		Kind:   "attachment",
		Source: "attachment",
		Mime:   "application/pdf",
	}})

	if !strings.Contains(section, "PDF extracted text from local parser") {
		t.Fatalf("expected pdftotext output in section, got %s", section)
	}
	if !strings.Contains(section, "source: pdftotext") || !strings.Contains(section, "status: included_text") {
		t.Fatalf("expected pdftotext included_text metadata, got %s", section)
	}
}

func TestBuildContextFileAttachmentContextExtractsImageOCRWithTesseract(t *testing.T) {
	dir := t.TempDir()
	binDir := t.TempDir()
	writeFakeCommand(t, binDir, "tesseract", "printf 'OCR extracted text from image'")
	t.Setenv("PATH", binDir)
	attachmentDir := filepath.Join(dir, ".ricochet", "attachments", "session-1")
	if err := os.MkdirAll(attachmentDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(attachmentDir, "screen.png"), []byte("not-a-real-png"), 0600); err != nil {
		t.Fatal(err)
	}
	controller := &Controller{cwd: dir}

	section := controller.buildContextFileAttachmentContext("please inspect", []protocol.ContextFileAttachment{{
		Path:   ".ricochet/attachments/session-1/screen.png",
		Name:   "screen.png",
		Kind:   "attachment",
		Source: "attachment",
		Mime:   "image/png",
	}})

	if !strings.Contains(section, "OCR extracted text from image") {
		t.Fatalf("expected OCR output in section, got %s", section)
	}
	if !strings.Contains(section, "source: tesseract_ocr") || !strings.Contains(section, "status: included_text") {
		t.Fatalf("expected OCR included_text metadata, got %s", section)
	}
}

func TestBuildContextFileAttachmentContextRejectsAttachmentOutsideStagingDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("should not leak"), 0600); err != nil {
		t.Fatal(err)
	}
	controller := &Controller{cwd: dir}

	section := controller.buildContextFileAttachmentContext("please inspect", []protocol.ContextFileAttachment{{
		Path:   "notes.txt",
		Name:   "notes.txt",
		Kind:   "attachment",
		Source: "attachment",
	}})

	if strings.Contains(section, "should not leak") {
		t.Fatalf("attachment outside staging dir leaked into section: %s", section)
	}
	if !strings.Contains(section, ".ricochet/attachments") {
		t.Fatalf("expected staging directory warning, got %s", section)
	}
}

func TestInjectionProcessorSkipsStructuredContextFilePaths(t *testing.T) {
	dir := t.TempDir()
	attachmentDir := filepath.Join(dir, ".ricochet", "attachments", "session-1")
	if err := os.MkdirAll(attachmentDir, 0700); err != nil {
		t.Fatal(err)
	}
	relPath := ".ricochet/attachments/session-1/notes.md"
	if err := os.WriteFile(filepath.Join(dir, relPath), []byte("attachment content"), 0600); err != nil {
		t.Fatal(err)
	}

	processor := NewInjectionProcessor(dir)
	expanded, info := processor.ProcessIgnoringPaths("Context Files:\n@"+relPath, []string{relPath})

	if strings.Contains(expanded, "Content of @") || strings.Contains(expanded, "attachment content") {
		t.Fatalf("structured attachment was duplicated by legacy injection: %s", expanded)
	}
	if len(info) != 0 {
		t.Fatalf("expected no visible injected file messages, got %#v", info)
	}
}

func writeFakeCommand(t *testing.T, dir, name, body string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
}
