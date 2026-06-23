package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/igoryan-dao/ricochet/internal/tui"
	"github.com/spf13/cobra"
)

type terminalLabOptions struct {
	fixture     string
	speed       float64
	noAltScreen bool
	snapshot    bool
	jsonl       bool
	width       int
	height      int
}

func newDevCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:    "dev",
		Short:  "Internal development tools",
		Hidden: true,
	}

	lab := &terminalLabOptions{fixture: "all", speed: 1}
	terminalLab := &cobra.Command{
		Use:   "terminal-lab",
		Short: "Replay terminal timeline fixtures",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTerminalLab(ctx, opts, lab)
		},
	}
	terminalLab.Flags().StringVar(&lab.fixture, "fixture", lab.fixture, "fixture: all, polybot, failed, slash-menu")
	terminalLab.Flags().Float64Var(&lab.speed, "speed", lab.speed, "replay speed multiplier")
	terminalLab.Flags().BoolVar(&lab.noAltScreen, "no-alt-screen", false, "run TUI without alternate screen")
	terminalLab.Flags().BoolVar(&lab.snapshot, "snapshot", false, "print final terminal frame and exit")
	terminalLab.Flags().BoolVar(&lab.jsonl, "jsonl", false, "print fixture RPC messages as JSONL and exit")
	terminalLab.Flags().IntVar(&lab.width, "width", 100, "snapshot terminal width")
	terminalLab.Flags().IntVar(&lab.height, "height", 120, "snapshot terminal height")
	cmd.AddCommand(terminalLab)
	return cmd
}

func runTerminalLab(ctx context.Context, opts *cliOptions, lab *terminalLabOptions) error {
	events, err := tui.TerminalLabFixture(lab.fixture)
	if err != nil {
		return err
	}
	if lab.jsonl {
		for _, event := range events {
			if event.RPCMessage == nil {
				continue
			}
			data, _ := json.Marshal(event.RPCMessage)
			fmt.Fprintln(os.Stdout, string(data))
		}
		return nil
	}
	if lab.snapshot {
		frame, err := renderTerminalLabSnapshot(opts.cwd, events, lab.width, lab.height)
		if err != nil {
			return err
		}
		fmt.Fprint(os.Stdout, stripANSI(frame))
		if len(frame) == 0 || frame[len(frame)-1] != '\n' {
			fmt.Fprintln(os.Stdout)
		}
		return nil
	}
	return runTerminalLabTUI(ctx, opts.cwd, lab.fixture, lab.speed, lab.noAltScreen)
}

func renderTerminalLabSnapshot(cwd string, events []tui.FixtureEvent, width, height int) (string, error) {
	previousLogWriter := log.Writer()
	log.SetOutput(io.Discard)
	defer log.SetOutput(previousLogWriter)

	if width < 60 {
		width = 60
	}
	if height < 24 {
		height = 24
	}
	msgChan := make(chan tea.Msg, len(events)+4)
	model := tui.NewModel(cwd, "terminal-lab", msgChan, nil)
	model.TerminalWidth = width
	model.TerminalHeight = height
	next, _ := model.Update(tea.WindowSizeMsg{Width: width, Height: height})
	model = next.(tui.Model)
	for _, event := range events {
		if event.Message == nil {
			continue
		}
		next, _ := model.Update(event.Message)
		model = next.(tui.Model)
	}
	model.UpdateViewport()
	return model.View(), nil
}

func runTerminalLabTUI(ctx context.Context, cwd, fixture string, speed float64, noAltScreen bool) error {
	_ = ctx
	msgChan := make(chan tea.Msg, 256)
	model := tui.NewModel(cwd, "terminal-lab", msgChan, nil)
	options := []tea.ProgramOption{}
	if !noAltScreen {
		options = append(options, tea.WithAltScreen())
	}
	program := tea.NewProgram(model, options...)
	go func() {
		msgChan <- tui.TimelineNoticeMsg{Kind: "Terminal Dev Lab", Title: "Terminal Dev Lab", Status: "running", Detail: "Replaying fixture " + fixture, Timestamp: time.Now().UnixMilli()}
		if err := tui.ReplayTerminalLabFixture(msgChan, fixture, speed); err != nil {
			msgChan <- tui.TimelineNoticeMsg{Kind: "Errors", Title: "Errors", Status: "failed", Error: err.Error(), Timestamp: time.Now().UnixMilli()}
		}
		msgChan <- tui.TimelineNoticeMsg{Kind: "Terminal Dev Lab", Title: "Terminal Dev Lab", Status: "completed", Detail: "Fixture complete. Press Ctrl+C to exit.", Timestamp: time.Now().UnixMilli()}
	}()
	_, err := program.Run()
	return err
}

var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

func stripANSI(value string) string {
	return ansiPattern.ReplaceAllString(value, "")
}
