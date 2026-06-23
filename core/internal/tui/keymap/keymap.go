package keymap

import (
	"fmt"
	"sort"
	"strings"
)

type Context string

const (
	ContextGlobal       Context = "Global"
	ContextChat         Context = "Chat"
	ContextAutocomplete Context = "Autocomplete"
	ContextPicker       Context = "Picker"
	ContextApproval     Context = "Approval"
	ContextPlan         Context = "Plan"
	ContextTimeline     Context = "Timeline"
	ContextHelp         Context = "Help"
)

type Action string

const (
	ActionInterrupt       Action = "app:interrupt"
	ActionExit            Action = "app:exit"
	ActionShortcuts       Action = "app:shortcuts"
	ActionTogglePlan      Action = "app:togglePlan"
	ActionToggleEther     Action = "app:toggleEther"
	ActionModelPicker     Action = "chat:modelPicker"
	ActionProviderPicker  Action = "chat:providerPicker"
	ActionSubmit          Action = "chat:submit"
	ActionNewline         Action = "chat:newline"
	ActionHistoryPrevious Action = "history:previous"
	ActionHistoryNext     Action = "history:next"
	ActionAccept          Action = "autocomplete:accept"
	ActionDismiss         Action = "autocomplete:dismiss"
	ActionPrevious        Action = "select:previous"
	ActionNext            Action = "select:next"
	ActionSelect          Action = "select:accept"
	ActionExpand          Action = "timeline:expand"
	ActionCopy            Action = "timeline:copy"
	ActionApprove         Action = "approval:approve"
	ActionApproveSession  Action = "approval:approveSession"
	ActionApprovePrefix   Action = "approval:approvePrefix"
	ActionDeny            Action = "approval:deny"
	ActionDebug           Action = "approval:debug"
	ActionExplain         Action = "approval:explain"
)

type Binding struct {
	Context Context
	Key     string
	Action  Action
	Label   string
}

var defaults = []Binding{
	{ContextGlobal, "ctrl+c", ActionInterrupt, "ctrl+c"},
	{ContextGlobal, "ctrl+d", ActionExit, "ctrl+d"},
	{ContextGlobal, "?", ActionShortcuts, "?"},
	{ContextGlobal, "ctrl+p", ActionTogglePlan, "ctrl+p"},
	{ContextGlobal, "ctrl+e", ActionToggleEther, "ctrl+e"},
	{ContextGlobal, "alt+e", ActionToggleEther, "alt+e"},
	{ContextChat, "enter", ActionSubmit, "enter"},
	{ContextChat, "alt+enter", ActionNewline, "alt+enter"},
	{ContextChat, "up", ActionHistoryPrevious, "up"},
	{ContextChat, "down", ActionHistoryNext, "down"},
	{ContextChat, "alt+m", ActionModelPicker, "alt+m"},
	{ContextChat, "alt+p", ActionProviderPicker, "alt+p"},
	{ContextAutocomplete, "tab", ActionAccept, "tab"},
	{ContextAutocomplete, "enter", ActionAccept, "enter"},
	{ContextAutocomplete, "esc", ActionDismiss, "esc"},
	{ContextAutocomplete, "up", ActionPrevious, "up"},
	{ContextAutocomplete, "down", ActionNext, "down"},
	{ContextPicker, "up", ActionPrevious, "up"},
	{ContextPicker, "down", ActionNext, "down"},
	{ContextPicker, "k", ActionPrevious, "k"},
	{ContextPicker, "j", ActionNext, "j"},
	{ContextPicker, "tab", ActionNext, "tab"},
	{ContextPicker, "shift+tab", ActionPrevious, "shift+tab"},
	{ContextPicker, "enter", ActionSelect, "enter"},
	{ContextPicker, "esc", ActionDismiss, "esc"},
	{ContextTimeline, "ctrl+r", ActionExpand, "ctrl+r"},
	{ContextTimeline, "ctrl+o", ActionCopy, "ctrl+o"},
	{ContextApproval, "y", ActionApprove, "y"},
	{ContextApproval, "enter", ActionApprove, "enter"},
	{ContextApproval, "a", ActionApproveSession, "a"},
	{ContextApproval, "p", ActionApprovePrefix, "p"},
	{ContextApproval, "d", ActionDeny, "d"},
	{ContextApproval, "n", ActionDeny, "n"},
	{ContextApproval, "esc", ActionDeny, "esc"},
	{ContextApproval, "ctrl+d", ActionDebug, "ctrl+d"},
	{ContextApproval, "ctrl+e", ActionExplain, "ctrl+e"},
	{ContextPlan, "a", ActionSubmit, "a"},
	{ContextPlan, "d", ActionDeny, "d"},
	{ContextPlan, "enter", ActionSelect, "enter"},
	{ContextPlan, "up", ActionPrevious, "up"},
	{ContextPlan, "down", ActionNext, "down"},
	{ContextHelp, "esc", ActionDismiss, "esc"},
}

func Defaults() []Binding {
	out := make([]Binding, len(defaults))
	copy(out, defaults)
	return out
}

func Shortcut(ctx Context, action Action, fallback string) string {
	for _, binding := range defaults {
		if binding.Context == ctx && binding.Action == action {
			return binding.Label
		}
	}
	for _, binding := range defaults {
		if binding.Action == action {
			return binding.Label
		}
	}
	return fallback
}

func HasAction(ctx Context, key string, action Action) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	for _, binding := range defaults {
		if binding.Context == ctx && binding.Key == key && binding.Action == action {
			return true
		}
	}
	for _, binding := range defaults {
		if binding.Context == ContextGlobal && binding.Key == key && binding.Action == action {
			return true
		}
	}
	return false
}

func RenderHelp() string {
	groups := map[Context][]Binding{}
	for _, binding := range defaults {
		groups[binding.Context] = append(groups[binding.Context], binding)
	}
	order := []Context{ContextGlobal, ContextChat, ContextAutocomplete, ContextPicker, ContextApproval, ContextPlan, ContextTimeline}
	var sb strings.Builder
	sb.WriteString("**Shortcuts**\n")
	for _, ctx := range order {
		bindings := groups[ctx]
		if len(bindings) == 0 {
			continue
		}
		sort.SliceStable(bindings, func(i, j int) bool { return bindings[i].Key < bindings[j].Key })
		sb.WriteString(fmt.Sprintf("\n**%s**\n", ctx))
		for _, binding := range bindings {
			sb.WriteString(fmt.Sprintf("- `%s` - %s\n", binding.Label, binding.Action))
		}
	}
	return strings.TrimSpace(sb.String())
}

func Validate() error {
	seen := map[string]Binding{}
	for _, binding := range defaults {
		key := string(binding.Context) + "\x00" + binding.Key
		if existing, ok := seen[key]; ok {
			return fmt.Errorf("duplicate binding %s in %s: %s and %s", binding.Key, binding.Context, existing.Action, binding.Action)
		}
		seen[key] = binding
	}
	return nil
}
