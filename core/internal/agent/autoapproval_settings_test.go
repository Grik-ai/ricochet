package agent

import (
	"testing"

	"github.com/igoryan-dao/ricochet/internal/config"
)

func TestAutoApprovalDeleteRequiresDeleteSetting(t *testing.T) {
	c := &Controller{
		cwd: "/repo",
		config: &Config{
			AutoApproval: &config.AutoApprovalSettings{
				Enabled:   true,
				EditFiles: true,
			},
		},
	}

	tc := ToolCallInfo{Name: "delete_file", Arguments: `{"path":"README.md"}`}
	if c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("delete_file was auto-approved by edit_files without delete_files")
	}

	c.config.AutoApproval.DeleteFiles = true
	if !c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("delete_file was not auto-approved when delete_files is enabled")
	}
}

func TestAutoApprovalExternalEditRequiresExternalSetting(t *testing.T) {
	c := &Controller{
		cwd: "/repo",
		config: &Config{
			AutoApproval: &config.AutoApprovalSettings{
				Enabled:   true,
				EditFiles: true,
			},
		},
	}

	tc := ToolCallInfo{Name: "write_file", Arguments: `{"path":"/tmp/outside.txt"}`}
	if c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("external write was auto-approved by edit_files without edit_files_external")
	}

	c.config.AutoApproval.EditFilesExternal = true
	if !c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("external write was not auto-approved when edit_files_external is enabled")
	}
}
