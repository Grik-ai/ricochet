package agent

import (
	"fmt"
)

// IncrementRetryCount increments the retry counter for a task
func (pm *PlanManager) IncrementRetryCount(taskID string) (int, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for i := range pm.Tasks {
		if pm.Tasks[i].ID == taskID {
			pm.Tasks[i].RetryCount++

			// Auto-save changes
			pm.saveInternal()

			return pm.Tasks[i].RetryCount, nil
		}
	}
	return 0, fmt.Errorf("task not found: %s", taskID)
}

// GetTask returns a copy of the task by ID
func (pm *PlanManager) GetTask(taskID string) (TaskItem, bool) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	for _, t := range pm.Tasks {
		if t.ID == taskID {
			return t, true
		}
	}
	return TaskItem{}, false
}


// AddTask removed (dup)

// RemoveTask removes a task by index (unsafe if no lock held by caller wrapper, but here we lock)
// Wait, TUI uses index mapping. Index might shift.
// Better to remove by ID, but TUI update used index.
// Let's implement RemoveTaskByIndex for TUI convenience, but be careful.
func (pm *PlanManager) RemoveTaskByIndex(index int) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if index < 0 || index >= len(pm.Tasks) {
		return fmt.Errorf("index out of bounds")
	}

	pm.Tasks = append(pm.Tasks[:index], pm.Tasks[index+1:]...)
	pm.saveInternal()
	return nil
}
