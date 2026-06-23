package workflow

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// AgentExecutor is the interface for executing agent prompts
type AgentExecutor interface {
	Execute(ctx context.Context, prompt string) (string, error)
}

// CommandExecutor is the interface for executing shell commands (for context injection)
type CommandExecutor interface {
	Execute(command string) (string, error)
}

// Engine drives the execution of workflows
type Engine struct {
	executor    AgentExecutor
	cmdExecutor CommandExecutor
}

func NewEngine(executor AgentExecutor, cmdExecutor CommandExecutor) *Engine {
	return &Engine{
		executor:    executor,
		cmdExecutor: cmdExecutor,
	}
}

// Execute runs a workflow definition
func (e *Engine) Execute(ctx context.Context, wf WorkflowDefinition, inputVars map[string]interface{}) (*ExecutionContext, error) {
	if inputVars == nil {
		inputVars = make(map[string]interface{})
	}
	execCtx := &ExecutionContext{
		WorkflowID: wf.Name,
		Variables:  inputVars,
		History:    make([]StepResult, 0),
	}

	for _, step := range wf.Steps {
		select {
		case <-ctx.Done():
			return execCtx, ctx.Err()
		default:
		}

		if err := e.executeStep(ctx, step, execCtx); err != nil {
			return execCtx, err
		}
	}

	return execCtx, nil
}

func (e *Engine) executeStep(ctx context.Context, step WorkflowStep, execCtx *ExecutionContext) error {
	result := StepResult{
		StepID: step.ID,
		Status: "running",
	}

	var err error
	var output string

	switch step.Type {
	case "parallel":
		output, err = e.executeParallel(ctx, step.Parallel, execCtx)
	case "agent":
		prompt, interpErr := e.interpolate(ctx, step.Action, execCtx.Variables, step.AllowCommandInjection)
		if interpErr != nil {
			err = interpErr
			break
		}
		output, err = e.executor.Execute(ctx, prompt)
	case "user_input":
		err = fmt.Errorf("workflow step %s requires unsupported user input", step.ID)
	default:
		// Default to agent if type unspecified but action exists
		if step.Action != "" {
			prompt, interpErr := e.interpolate(ctx, step.Action, execCtx.Variables, step.AllowCommandInjection)
			if interpErr != nil {
				err = interpErr
				break
			}
			output, err = e.executor.Execute(ctx, prompt)
		}
	}

	if err != nil {
		result.Status = "failed"
		result.Output = err.Error()
		execCtx.History = append(execCtx.History, result)
		return err
	}

	result.Status = "success"
	result.Output = output
	execCtx.History = append(execCtx.History, result)
	execCtx.Variables["last_output"] = output
	execCtx.Variables[fmt.Sprintf("step.%s.output", step.ID)] = output

	return nil
}

func (e *Engine) executeParallel(ctx context.Context, steps []WorkflowStep, parentCtx *ExecutionContext) (string, error) {
	var wg sync.WaitGroup
	results := make(map[string]string)
	var mu sync.Mutex
	var errs []error

	for _, step := range steps {
		wg.Add(1)
		go func(s WorkflowStep) {
			defer wg.Done()

			// Create isolated context if needed, or share vars
			// For parallel agents, we just execute the prompt
			// TODO: How to handle shared context writes? For now read-only.

			prompt, interpErr := e.interpolate(ctx, s.Action, parentCtx.Variables, s.AllowCommandInjection)
			if interpErr != nil {
				mu.Lock()
				errs = append(errs, fmt.Errorf("step %s failed: %w", s.ID, interpErr))
				mu.Unlock()
				return
			}
			out, err := e.executor.Execute(ctx, prompt)

			mu.Lock()
			defer mu.Unlock()

			if err != nil {
				errs = append(errs, fmt.Errorf("step %s failed: %w", s.ID, err))
			} else {
				results[s.ID] = out
			}
		}(step)
	}

	wg.Wait()

	if len(errs) > 0 {
		return "", fmt.Errorf("parallel execution failed with %d errors", len(errs))
	}

	// Aggregate results
	// For now returns a simple string representation
	// In the future, this should probably return a structured map
	var agg string
	for id, res := range results {
		agg += fmt.Sprintf("--- Result from %s ---\n%s\n\n", id, res)
	}
	return agg, nil
}

// Simple variable interpolation {{var}} and gated Command Injection !`cmd`.
func (e *Engine) interpolate(_ context.Context, text string, vars map[string]interface{}, allowCommandInjection bool) (string, error) {
	// 1. Variable Substitution {{var}}
	for k, v := range vars {
		placeholder := fmt.Sprintf("{{%s}}", k)
		valStr := fmt.Sprintf("%v", v)
		text = strings.ReplaceAll(text, placeholder, valStr)
	}

	// 2. Command Injection !`cmd`
	// Regex would be safer, but simple parsing works for MVP
	// Look for !`
	for {
		startIdx := strings.Index(text, "!`")
		if startIdx == -1 {
			break
		}
		if !allowCommandInjection {
			return "", fmt.Errorf("command injection is disabled for this workflow step")
		}
		if e.cmdExecutor == nil {
			return "", fmt.Errorf("command injection requested but no command executor is configured")
		}

		endIdx := strings.Index(text[startIdx+2:], "`")
		if endIdx == -1 {
			break // Unclosed backtick
		}
		endIdx += startIdx + 2

		cmd := text[startIdx+2 : endIdx]

		// Execute Command
		// We ignore errors here to not crash the prompt, just inject error msg
		// TODO: Executor needs to support ExecuteCommand
		res, err := e.cmdExecutor.Execute(cmd)
		output := res
		if err != nil {
			output = fmt.Sprintf("[Error executing `%s`: %v]", cmd, err)
		} else if output == "" {
			output = "(no output)"
		}

		// Replace the whole !`...` block
		text = text[:startIdx] + output + text[endIdx+1:]
	}

	return text, nil
}
