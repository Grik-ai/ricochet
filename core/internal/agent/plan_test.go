package agent

import (
	"os"
	"testing"
)

func TestPlanManagerTasks(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "plan_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	pm := NewPlanManager(tempDir)

	// 1. Create Task
	id, err := pm.CreateTask("Test Task", "Description", 2, nil, nil, "Success")
	if err != nil {
		t.Errorf("Failed to create task: %v", err)
	}
	if id == "" {
		t.Error("Expected task ID, got empty string")
	}

	// 2. List Tasks
	tasks := pm.ListTasks("")
	if len(tasks) != 1 {
		t.Errorf("Expected 1 task, got %d", len(tasks))
	}

	// 3. Get Next Task
	next, err := pm.GetNextTask()
	if err != nil {
		t.Errorf("Failed to get next task: %v", err)
	}
	if next == nil || next.ID != id {
		t.Errorf("Expected next task ID %s, got %v", id, next)
	}

	// 4. Add Subtask
	err = pm.AddSubtask(id, "Subtask 1")
	if err != nil {
		t.Errorf("Failed to add subtask: %v", err)
	}

	tasks = pm.ListTasks("")
	if len(tasks) == 0 || len(tasks[0].Subtasks) != 1 {
		t.Errorf("Expected 1 subtask, got %v", tasks)
	}

	// 5. Complete Task
	err = pm.CompleteTask(id, "Done")
	if err != nil {
		t.Errorf("Failed to complete task: %v", err)
	}

	tasks = pm.ListTasks("done")
	if len(tasks) != 1 {
		t.Errorf("Expected 1 done task, got %d", len(tasks))
	}

	// 6. Update Task
	err = pm.UpdateTask(id, "Updated Title", "Updated Desc", 3, nil, "New Outcome")
	if err != nil {
		t.Errorf("Failed to update task: %v", err)
	}
	tasks = pm.ListTasks("")
	if tasks[0].Title != "Updated Title" || tasks[0].Priority != 3 {
		t.Errorf("Task update failed: %+v", tasks[0])
	}

	// 7. OnChanged Callback
	called := false
	pm.OnChanged = func() { called = true }
	id2, _ := pm.CreateTask("Callback Task", "...", 1, nil, nil, "")
	if !called {
		t.Error("OnChanged callback was not triggered on CreateTask")
	}

	// 8. Delete Task
	err = pm.DeleteTask(id)
	if err != nil {
		t.Errorf("Failed to delete task: %v", err)
	}
	tasks = pm.ListTasks("")
	if len(tasks) != 1 || tasks[0].ID != id2 {
		t.Errorf("Delete task failed. Expected 1 task (ID2), got %d tasks", len(tasks))
	}
}
