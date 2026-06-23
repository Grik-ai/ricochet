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
	if !strings.Contains(section, "Attached Workspace Files") {
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
