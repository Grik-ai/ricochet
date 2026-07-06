package host

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
)

// SimpleBuffer is a thread-safe byte buffer
type SimpleBuffer struct {
	buffer []byte
	mu     sync.RWMutex
}

func (b *SimpleBuffer) Write(p []byte) (n int, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buffer = append(b.buffer, p...)
	// Truncate if too large to prevent memory leak (e.g. 1MB)
	if len(b.buffer) > 1024*1024 {
		cut := len(b.buffer) - 1024*1024
		b.buffer = b.buffer[cut:]
	}
	return len(p), nil
}

func (b *SimpleBuffer) String() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return string(b.buffer)
}

func (b *SimpleBuffer) SnapshotSince(offset int) (string, int) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if offset < 0 || offset > len(b.buffer) {
		offset = 0
	}
	return string(b.buffer[offset:]), len(b.buffer)
}

type PTYCallbacks struct {
	OnOutput func(session *PTYSession, chunk []byte)
	OnExit   func(session *PTYSession, err error)
}

// PTYSession represents an active pseudo-terminal
type PTYSession struct {
	ID           string
	Command      string
	Cwd          string
	Cmd          *exec.Cmd
	PTY          *os.File // The pseudo-terminal file
	Output       *SimpleBuffer
	CreatedAt    time.Time
	Running      bool
	ReadOffset   int
	ExitErr      string
	ClosedByUser bool
	mu           sync.Mutex
}

func (s *PTYSession) SnapshotStatus() (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Running, s.ExitErr
}

// PTYManager manages multiple PTY sessions
type PTYManager struct {
	sessions map[string]*PTYSession
	mu       sync.RWMutex
}

func NewPTYManager() *PTYManager {
	return &PTYManager{
		sessions: make(map[string]*PTYSession),
	}
}

func (m *PTYManager) Start(command string, args []string, cwd string, env []string) (*PTYSession, error) {
	return m.StartWithCallbacks(command, args, cwd, env, PTYCallbacks{})
}

func (m *PTYManager) StartWithCallbacks(command string, args []string, cwd string, env []string, callbacks PTYCallbacks) (*PTYSession, error) {
	// Create command
	c := exec.Command(command, args...)
	c.Dir = cwd
	if len(env) > 0 {
		c.Env = append(os.Environ(), env...)
	}

	// Start PTY
	ptmx, err := pty.Start(c)
	if err != nil {
		return nil, fmt.Errorf("failed to start pty: %w", err)
	}

	id := uuid.New().String()
	outputBuf := &SimpleBuffer{}

	session := &PTYSession{
		ID:        id,
		Command:   command,
		Cwd:       cwd,
		Cmd:       c,
		PTY:       ptmx,
		Output:    outputBuf,
		CreatedAt: time.Now(),
		Running:   true,
	}

	// Copy PTY output to buffer
	go func() {
		_, copyErr := io.Copy(&ptyOutputWriter{session: session, callbacks: callbacks}, ptmx)
		waitErr := c.Wait()
		exitErr := waitErr
		if exitErr == nil {
			exitErr = copyErr
		}
		session.mu.Lock()
		session.Running = false
		closedByUser := session.ClosedByUser
		if exitErr != nil {
			session.ExitErr = exitErr.Error()
		}
		session.mu.Unlock()
		if callbacks.OnExit != nil && !closedByUser {
			callbacks.OnExit(session, exitErr)
		}
	}()

	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()

	return session, nil
}

type ptyOutputWriter struct {
	session   *PTYSession
	callbacks PTYCallbacks
}

func (w *ptyOutputWriter) Write(p []byte) (int, error) {
	n, err := w.session.Output.Write(p)
	if w.callbacks.OnOutput != nil && n > 0 {
		chunk := make([]byte, n)
		copy(chunk, p[:n])
		w.callbacks.OnOutput(w.session, chunk)
	}
	return n, err
}

// GetSession retrieves a running session
func (m *PTYManager) GetSession(id string) *PTYSession {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id]
}

// WriteInput sends data to the PTY
func (m *PTYManager) WriteInput(id string, data string) error {
	session := m.GetSession(id)
	if session == nil {
		return fmt.Errorf("session not found: %s", id)
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if !session.Running {
		return fmt.Errorf("session is not running")
	}

	_, err := session.PTY.WriteString(data)
	return err
}

// ReadOutput retrieves new buffer content since the previous read.
func (m *PTYManager) ReadOutput(id string) (string, error) {
	session := m.GetSession(id)
	if session == nil {
		return "", fmt.Errorf("session not found: %s", id)
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	output, nextOffset := session.Output.SnapshotSince(session.ReadOffset)
	session.ReadOffset = nextOffset
	return output, nil
}

// Close terminates the PTY session
func (m *PTYManager) Close(id string) error {
	session := m.GetSession(id)
	if session == nil {
		return nil
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if session.Running {
		session.ClosedByUser = true
		// Kill process
		if session.Cmd.Process != nil {
			_ = session.Cmd.Process.Kill()
		}
		// Close PTY
		_ = session.PTY.Close()
		session.Running = false
	}

	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()

	return nil
}
