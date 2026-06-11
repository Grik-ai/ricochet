package agent

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	context_manager "github.com/igoryan-dao/ricochet/internal/context"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// SessionData is the persistable part of a session
type SessionData struct {
	ID                  string                   `json:"id"`
	Messages            []protocol.Message       `json:"messages"`
	Todos               []protocol.Todo          `json:"todos"`
	MessageQueue        []protocol.QueuedMessage `json:"message_queue,omitempty"`
	BatchWorkerID       string                   `json:"batch_worker_id,omitempty"`
	AllowedRoot         string                   `json:"allowed_root,omitempty"`
	ScopePaths          []string                 `json:"scope_paths,omitempty"`
	IsolatedAutoApprove bool                     `json:"isolated_auto_approve,omitempty"`
	PlanApproved        bool                     `json:"plan_approved"`
	PlanReviewRequested bool                     `json:"plan_review_requested"`
	CreatedAt           time.Time                `json:"created_at"`
}

// SessionManager handles concurrent agents and their persistence
type SessionManager struct {
	mu         sync.RWMutex
	sessions   map[string]*Session
	storageDir string
}

func NewSessionManager(storageDir string) *SessionManager {
	if storageDir != "" {
		if err := os.MkdirAll(storageDir, 0700); err != nil {
			log.Printf("Warning: failed to create storage dir: %v", err)
		}
	}

	manager := &SessionManager{
		sessions:   make(map[string]*Session),
		storageDir: storageDir,
	}

	manager.LoadAll()
	return manager
}

func (m *SessionManager) CreateSession() *Session {
	id := "s_" + uuid.New().String()
	return m.CreateSessionWithID(id)
}

func (m *SessionManager) CreateSessionWithID(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()

	// If it already exists (race condition check), return it
	if session, ok := m.sessions[id]; ok {
		return session
	}

	session := &Session{
		ID:           id,
		StateHandler: NewMessageStateHandler(id),
		FileTracker:  context_manager.NewFileTracker(),
		CreatedAt:    time.Now(),
	}

	m.sessions[id] = session
	m.saveLocked(session)
	return session
}

func (m *SessionManager) GetSession(id string) *Session {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if ok {
		return session
	}

	// Default session
	if id == "default" {
		return m.CreateSessionWithID("default")
	}

	return nil
}

func (m *SessionManager) ListSessions() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var list []*Session
	for _, s := range m.sessions {
		list = append(list, s)
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].CreatedAt.After(list[j].CreatedAt)
	})

	return list
}

func (m *SessionManager) Save(id string) error {
	if m.storageDir == "" {
		return nil
	}

	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("session not found: %s", id)
	}

	return m.saveLocked(session)
}

// saveLocked saves a session to disk. It assumes the caller holds the lock (read or write).
func (m *SessionManager) saveLocked(session *Session) error {
	if m.storageDir == "" {
		return nil
	}

	data := SessionData{
		ID:                  session.ID,
		Messages:            session.StateHandler.GetMessages(),
		Todos:               session.Todos,
		MessageQueue:        session.MessageQueue,
		BatchWorkerID:       session.BatchWorkerID,
		AllowedRoot:         session.AllowedRoot,
		ScopePaths:          session.ScopePaths,
		IsolatedAutoApprove: session.IsolatedAutoApprove,
		PlanApproved:        session.PlanApproved,
		PlanReviewRequested: session.PlanReviewRequested,
		CreatedAt:           session.CreatedAt,
	}

	bytes, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}

	path := filepath.Join(m.storageDir, session.ID+".json")
	return atomicWriteSessionFile(path, bytes, 0600)
}

func atomicWriteSessionFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func (m *SessionManager) LoadAll() {
	if m.storageDir == "" {
		return
	}

	files, err := os.ReadDir(m.storageDir)
	if err != nil {
		return
	}

	for _, f := range files {
		if filepath.Ext(f.Name()) == ".json" {
			data, err := os.ReadFile(filepath.Join(m.storageDir, f.Name()))
			if err != nil {
				continue
			}

			var sd SessionData
			if err := json.Unmarshal(data, &sd); err != nil {
				continue
			}

			session := &Session{
				ID:                  sd.ID,
				StateHandler:        NewMessageStateHandler(sd.ID),
				FileTracker:         context_manager.NewFileTracker(),
				Todos:               sd.Todos,
				MessageQueue:        sd.MessageQueue,
				BatchWorkerID:       sd.BatchWorkerID,
				AllowedRoot:         sd.AllowedRoot,
				ScopePaths:          sd.ScopePaths,
				IsolatedAutoApprove: sd.IsolatedAutoApprove,
				PlanApproved:        sd.PlanApproved,
				PlanReviewRequested: sd.PlanReviewRequested,
				CreatedAt:           sd.CreatedAt,
			}
			session.StateHandler.SetMessages(sd.Messages)

			m.mu.Lock()
			m.sessions[sd.ID] = session
			m.mu.Unlock()
		}
	}
}

func (m *SessionManager) SaveAll() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, s := range m.sessions {
		m.saveLocked(s)
	}
}

func (m *SessionManager) DeleteSession(id string) error {
	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()

	if m.storageDir != "" {
		path := filepath.Join(m.storageDir, id+".json")
		os.Remove(path)
	}
	return nil
}
