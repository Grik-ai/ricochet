package agent

import (
	"github.com/igoryan-dao/ricochet/internal/modes"
	"github.com/igoryan-dao/ricochet/internal/tools"
)

func modeAllowsTool(mode modes.Mode, toolName string, category tools.ToolCategory) bool {
	if modes.IsToolAllowed(mode, toolName) {
		return true
	}
	for _, group := range mode.ToolGroups {
		switch group {
		case "read":
			if category == tools.CategoryRead || category == tools.CategoryMeta {
				return true
			}
		case "edit":
			if category == tools.CategoryWrite {
				return true
			}
		case "command":
			if category == tools.CategoryExecute {
				return true
			}
		case "browser":
			if category == tools.CategoryBrowser {
				return true
			}
		case "mcp":
			if category == tools.CategoryMCP {
				return true
			}
		}
	}
	return false
}
