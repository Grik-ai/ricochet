package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/memory"
	"github.com/igoryan-dao/ricochet/internal/paths"
)

func appendSessionMemory(cwd, sessionID, runID, source, content string) error {
	content = strings.TrimSpace(content)
	if sessionID == "" || len(content) < 180 {
		return nil
	}
	if memory.LooksLikeSecret(content) {
		return nil
	}

	dir := filepath.Join(paths.GetGlobalDir(), "session-memory", paths.GetWorkspaceHash(cwd))
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	path := filepath.Join(dir, sessionID+".md")
	entry := fmt.Sprintf(
		"\n\n## %s\n\n- run: `%s`\n- source: `%s`\n\n%s\n",
		time.Now().Format(time.RFC3339),
		runID,
		source,
		content,
	)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(entry)
	return err
}
