package memory

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/paths"
)

const (
	MemDirFileName = "MEMORY.md"
	MemDirHeader   = "# Ricochet Memory Index\n\nThis file is managed by the agent to persist long-term knowledge across sessions.\n"
)

// MemDir handles the transparent, model-managed memory index
type MemDir struct {
	root string
	path string
}

func NewMemDir(cwd string) *MemDir {
	dir := filepath.Join(paths.GetGlobalDir(), "agent-memory", paths.GetWorkspaceHash(cwd))
	if strings.EqualFold(os.Getenv("RICOCHET_PROJECT_MEMORY"), "1") ||
		strings.EqualFold(os.Getenv("RICOCHET_PROJECT_MEMORY"), "true") {
		dir = filepath.Join(cwd, ".ricochet")
	}
	_ = os.MkdirAll(dir, 0755)

	path := filepath.Join(dir, MemDirFileName)
	// Ensure file exists with header if new in global storage. Project-local memory
	// only happens behind RICOCHET_PROJECT_MEMORY to avoid repo pollution by default.
	if _, err := os.Stat(path); os.IsNotExist(err) {
		_ = os.WriteFile(path, []byte(MemDirHeader), 0644)
	}

	return &MemDir{
		root: dir,
		path: path,
	}
}

func (m *MemDir) GetContent() string {
	data, err := os.ReadFile(m.path)
	if err != nil {
		return ""
	}
	return string(data)
}

func (m *MemDir) GetPromptSection() string {
	content := m.GetContent()

	var sb strings.Builder
	sb.WriteString("\n\n### 🧠 BORTVOY MEMORY (MEMORY.md)\n")
	sb.WriteString(fmt.Sprintf("You have a persistent, file-based memory system managed by Ricochet storage as `%s`.\n", MemDirFileName))
	sb.WriteString("You should build up this memory system over time so that future conversations can have a complete picture of who the user is, project context, and your learned behaviors.\n\n")
	sb.WriteString("## How to use memory\n")
	sb.WriteString("1. **Read**: Review the index below to orient yourself.\n")
	sb.WriteString("2. **Write**: Update memory only through Ricochet memory tools or explicit user-approved project memory files.\n")
	sb.WriteString("3. **Distinction**: Use memory for information that will be useful in FUTURE conversations. Use 'Plan' or 'Tasks' for the CURRENT conversation.\n")
	sb.WriteString("4. **Taxonomy**: Organize by User Preferences, Feedback, Project Intent, or Reference.\n")

	if strings.TrimSpace(content) == "" || strings.TrimSpace(content) == strings.TrimSpace(MemDirHeader) {
		sb.WriteString("\n*Current Memory index is empty. Start by recording project goals or user preferences.*\n")
	} else {
		sb.WriteString("\n## Memory Index Content:\n")
		sb.WriteString(content)
	}

	return sb.String()
}
