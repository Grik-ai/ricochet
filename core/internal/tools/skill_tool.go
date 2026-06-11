package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/skills"
)

// ListSkillsTool returns headers for available skills
type ListSkillsTool struct {
	Manager *skills.Manager
}

func (t *ListSkillsTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "list_available_skills",
		Description: "List available skills for the current context. Returns metadata only; use invoke_skill to load full instructions.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"prompt_hint": map[string]interface{}{
					"type":        "string",
					"description": "Optional keyword or intent hint to narrow down skills",
				},
			},
		},
	}
}

func (t *ListSkillsTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		PromptHint string `json:"prompt_hint"`
	}
	json.Unmarshal(args, &payload)

	headers := t.Manager.GetAvailableSkillHeaders(payload.PromptHint, nil)
	if len(headers) == 0 {
		return "No specific skills currently recommended for this context.", nil
	}

	data, _ := json.MarshalIndent(headers, "", "  ")
	return string(data), nil
}

// InvokeSkillTool injects a skill's full content into the context
type InvokeSkillTool struct {
	Manager *skills.Manager
}

func (t *InvokeSkillTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "invoke_skill",
		Description: "Load the full content and specialized instructions of a skill into the current context window.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"name": map[string]interface{}{
					"type":        "string",
					"description": "Name of the skill to invoke",
				},
			},
			"required": []string{"name"},
		},
	}
}

func (t *InvokeSkillTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", err
	}

	skill, ok := t.Manager.GetSkill(payload.Name)
	if !ok {
		return "", fmt.Errorf("skill '%s' not found", payload.Name)
	}

	// Format output for the LLM
	scope, scoped := t.Manager.ActivateSkillScope(protocol.GetSessionID(ctx), skill.Name)

	res := fmt.Sprintf("=== SKILL INVOKED: %s ===\n%s\n\n", skill.Name, skill.Description)
	if skill.WhenToUse != "" {
		res += "WHEN TO USE:\n" + skill.WhenToUse + "\n\n"
	}
	if skill.ArgumentHint != "" {
		res += "ARGUMENT HINT:\n" + skill.ArgumentHint + "\n\n"
	}
	res += "INSTRUCTIONS:\n" + skill.Content

	if scoped {
		res += "\n\nACTIVE SKILL TOOL SCOPE:\n"
		res += fmt.Sprintf("Skill `%s` may use only these tools until the next user request resets the scope:\n", scope.SkillName)
		for _, tool := range scope.AllowedTools {
			res += "- " + tool + "\n"
		}
	} else if len(skill.AllowedTools) > 0 {
		res += "\n\nALLOWED TOOLS:\n"
		for _, tool := range skill.AllowedTools {
			res += "- " + tool + "\n"
		}
	}

	return res, nil
}
