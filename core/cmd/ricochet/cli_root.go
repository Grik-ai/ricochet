package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/grikauth"
	"github.com/igoryan-dao/ricochet/internal/mcp"
	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
	"github.com/igoryan-dao/ricochet/internal/version"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

type cliOptions struct {
	cwd             string
	sessionID       string
	serverAddr      string
	model           string
	provider        string
	configOverrides []string
	approvalMode    string
	jsonOut         bool
	jsonl           bool
	noColor         bool
	live            bool

	legacyServer bool
	legacyStdio  bool
	legacyTUI    bool
	legacyDaemon bool
	port         string
}

func executeRoot(ctx context.Context, cwd string) error {
	opts := &cliOptions{
		cwd:        cwd,
		sessionID:  "cli-default",
		serverAddr: "localhost:5555",
		port:       "5555",
	}

	root := &cobra.Command{
		Use:           "ricochet [prompt]",
		Short:         "Ricochet coding agent CLI",
		SilenceUsage:  true,
		SilenceErrors: true,
		Args:          cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.legacyServer || opts.legacyDaemon {
				return runServerCommand(ctx, opts, opts.legacyDaemon)
			}
			if opts.legacyStdio {
				return runStdioCommand(ctx, opts)
			}
			if opts.legacyTUI || len(args) == 0 && isatty.IsTerminal(os.Stdout.Fd()) && isatty.IsTerminal(os.Stdin.Fd()) {
				return runTUICommand(ctx, opts)
			}
			if len(args) > 0 {
				return runPromptCommand(ctx, opts, strings.Join(args, " "))
			}
			return fmt.Errorf("non-interactive use requires `ricochet run`, `ricochet chat <prompt>`, or `ricochet mcp-server`")
		},
	}

	root.PersistentFlags().StringVar(&opts.cwd, "cwd", cwd, "workspace directory")
	root.PersistentFlags().StringVarP(&opts.sessionID, "session", "i", opts.sessionID, "session ID")
	root.PersistentFlags().StringVarP(&opts.serverAddr, "server-addr", "s", opts.serverAddr, "Ricochet daemon address")
	root.PersistentFlags().StringVar(&opts.model, "model", "", "override model for this command")
	root.PersistentFlags().StringVar(&opts.provider, "provider", "", "override provider for this command")
	root.PersistentFlags().StringArrayVarP(&opts.configOverrides, "config", "c", nil, "settings override, key=value")
	root.PersistentFlags().StringVar(&opts.approvalMode, "approval-mode", "", "approval mode: ask, auto, full")
	root.PersistentFlags().BoolVar(&opts.jsonOut, "json", false, "print JSON output")
	root.PersistentFlags().BoolVar(&opts.jsonl, "jsonl", false, "stream JSONL events")
	root.PersistentFlags().BoolVar(&opts.noColor, "no-color", false, "disable colorized output")
	root.PersistentFlags().BoolVar(&opts.live, "live", false, "enable Live/Ether mode for this command")

	root.Flags().BoolVar(&opts.legacyServer, "server", false, "legacy: start WebSocket server")
	root.Flags().BoolVar(&opts.legacyStdio, "stdio", false, "legacy: run stdio sidecar")
	root.Flags().BoolVar(&opts.legacyTUI, "tui", false, "force TUI mode")
	root.Flags().BoolVar(&opts.legacyDaemon, "daemon", false, "legacy: start daemon")
	root.Flags().StringVar(&opts.port, "port", opts.port, "daemon/server port")

	root.AddCommand(newChatCommand(ctx, opts))
	root.AddCommand(newRunCommand(ctx, opts))
	root.AddCommand(newDaemonCommand(ctx, opts))
	root.AddCommand(newSessionsCommand(ctx, opts))
	root.AddCommand(newConfigCommand(opts))
	root.AddCommand(newAuthCommand(ctx, opts))
	root.AddCommand(newLoginCommand(ctx, opts))
	root.AddCommand(newLogoutCommand(opts))
	root.AddCommand(newAccountCommand(ctx, opts))
	root.AddCommand(newProvidersCommand(opts))
	root.AddCommand(newModelsCommand(opts))
	root.AddCommand(newPermissionsCommand(opts))
	root.AddCommand(newMCPCommand(opts))
	root.AddCommand(newLiveCommand(ctx, opts))
	root.AddCommand(newCheckpointCommand(ctx, opts))
	root.AddCommand(newReviewCommand(ctx, opts))
	root.AddCommand(newDoctorCommand(opts))
	root.AddCommand(newDevCommand(ctx, opts))
	root.AddCommand(newVersionCommand(opts))
	root.AddCommand(&cobra.Command{
		Use:   "mcp-server",
		Short: "Run Ricochet as an MCP server",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runMCPMode(ctx)
		},
	})

	return root.Execute()
}

func newVersionCommand(opts *cliOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Show Ricochet core version and binary diagnostics",
		RunE: func(cmd *cobra.Command, args []string) error {
			info := version.Get()
			if opts.jsonOut {
				writeJSON(os.Stdout, info)
				return nil
			}
			fmt.Printf("Ricochet %s\n", info.Version)
			fmt.Printf("commit: %s\n", info.Commit)
			fmt.Printf("build_time: %s\n", info.BuildTime)
			fmt.Printf("executable: %s\n", info.ExecutablePath)
			return nil
		},
	}
}

func newChatCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "chat [prompt]",
		Short: "Start an interactive chat or send one prompt",
		Args:  cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return runPromptCommand(ctx, opts, strings.Join(args, " "))
			}
			return runInteractiveChat(ctx, opts)
		},
	}
}

func newRunCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "run [prompt]",
		Short: "Run a single non-interactive prompt",
		Args:  cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			prompt := strings.TrimSpace(strings.Join(args, " "))
			if prompt == "" && !isatty.IsTerminal(os.Stdin.Fd()) {
				data, err := io.ReadAll(os.Stdin)
				if err != nil {
					return err
				}
				prompt = strings.TrimSpace(string(data))
			}
			if prompt == "" {
				return fmt.Errorf("prompt is required")
			}
			return runPromptCommand(ctx, opts, prompt)
		},
	}
}

func newDaemonCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "daemon", Short: "Manage the Ricochet daemon"}
	cmd.AddCommand(&cobra.Command{
		Use:   "start",
		Short: "Start the daemon in the foreground",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runServerCommand(ctx, opts, true)
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show daemon health",
		RunE: func(cmd *cobra.Command, args []string) error {
			return printDaemonStatus(ctx, opts)
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "stop",
		Short: "Stop the daemon recorded in ~/.ricochet/core.pid",
		RunE: func(cmd *cobra.Command, args []string) error {
			return stopDaemon()
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "logs",
		Short: "Print known daemon log locations",
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Printf("TUI log: %s\n", filepath.Join(opts.cwd, "ricochet.log"))
			fmt.Printf("Workspace logs: %s\n", paths.GetLogDir(opts.cwd))
			return nil
		},
	})
	return cmd
}

func newSessionsCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "sessions", Short: "Manage daemon sessions"}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List sessions",
		RunE: func(cmd *cobra.Command, args []string) error {
			return requestAndPrint(ctx, opts, "list_sessions", nil)
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "new [session-id]",
		Short: "Create a session",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			sessionID := opts.sessionID
			if len(args) > 0 {
				sessionID = args[0]
			}
			return requestAndPrint(ctx, opts, "create_session", map[string]string{"session_id": sessionID})
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "resume [session-id]",
		Short: "Load session state",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			sessionID := opts.sessionID
			if len(args) > 0 {
				sessionID = args[0]
			}
			return requestAndPrint(ctx, opts, "get_state", map[string]string{"session_id": sessionID})
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "delete <session-id>",
		Short: "Delete a session",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return requestAndPrint(ctx, opts, "delete_session", map[string]string{"session_id": args[0]})
		},
	})
	return cmd
}

func newConfigCommand(opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "config", Short: "Inspect and edit settings"}
	cmd.AddCommand(&cobra.Command{
		Use:   "get [key]",
		Short: "Get settings or one dotted key",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			value := any(store.Get())
			if len(args) > 0 {
				found, ok := getDottedValue(value, args[0])
				if !ok {
					return fmt.Errorf("setting %q not found", args[0])
				}
				value = redactSecrets(found)
			} else {
				value = redactSecrets(value)
			}
			writeJSON(os.Stdout, value)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "set <key> <value>",
		Short: "Set a dotted setting key",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return updateSetting(args[0], args[1])
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "edit",
		Short: "Open settings.json in $EDITOR",
		RunE: func(cmd *cobra.Command, args []string) error {
			return editFile(filepath.Join(paths.GetGlobalDir(), "settings.json"))
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "doctor",
		Short: "Check local settings consistency",
		RunE: func(cmd *cobra.Command, args []string) error {
			return printConfigDoctor()
		},
	})
	return cmd
}

func newAuthCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "auth", Short: "Manage Grik Account authentication"}
	cmd.AddCommand(newLoginCommand(ctx, opts))
	cmd.AddCommand(newLogoutCommand(opts))
	cmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show Grik Account authentication status",
		RunE: func(cmd *cobra.Command, args []string) error {
			return printAuthStatus(ctx, opts)
		},
	})
	var showToken bool
	tokenCmd := &cobra.Command{
		Use:   "token",
		Short: "Show saved token status, or the raw token with --show",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			token, source := grikauth.AccessToken(store.Get())
			if opts.jsonOut {
				writeJSON(os.Stdout, map[string]interface{}{
					"configured": token != "",
					"source":     source,
					"token":      redactTokenForOutput(token, showToken),
				})
				return nil
			}
			if token == "" {
				fmt.Println("token: missing")
				return nil
			}
			fmt.Printf("token: %s\nsource: %s\n", redactTokenForOutput(token, showToken), source)
			return nil
		},
	}
	tokenCmd.Flags().BoolVar(&showToken, "show", false, "print the raw token")
	cmd.AddCommand(tokenCmd)
	return cmd
}

func newLoginCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Sign in to Grik Account",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			client := grikauth.NewClient()
			loginCtx, cancel := context.WithTimeout(ctx, 20*time.Minute)
			defer cancel()
			code, err := client.StartDeviceLogin(loginCtx, "ricochet-cli")
			if err != nil {
				return err
			}
			if opts.jsonOut {
				writeJSON(os.Stdout, map[string]interface{}{
					"verificationUrl": code.VerificationURL,
					"userCode":        code.UserCode,
					"expiresAt":       code.ExpiresAt.UnixMilli(),
				})
			} else {
				fmt.Printf("Open: %s\nCode: %s\nWaiting for approval until %s...\n", code.VerificationURL, code.UserCode, code.ExpiresAt.Format(time.Kitchen))
			}
			tokens, err := client.WaitForDeviceToken(loginCtx, code)
			if err != nil {
				return err
			}
			if err := grikauth.SaveTokens(store, tokens); err != nil {
				return err
			}
			if opts.jsonOut {
				writeJSON(os.Stdout, map[string]interface{}{"ok": true, "expiresAt": tokens.ExpiresAt.UnixMilli()})
				return nil
			}
			fmt.Println("Signed in to Grik Account.")
			return nil
		},
	}
}

func newLogoutCommand(opts *cliOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Sign out from Grik Account",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			if err := grikauth.ClearTokens(store); err != nil {
				return err
			}
			if opts.jsonOut {
				writeJSON(os.Stdout, map[string]bool{"ok": true})
			} else {
				fmt.Println("Signed out.")
			}
			return nil
		},
	}
}

func newAccountCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "account",
		Short: "Show Grik Account billing and hosted Ricochet models",
		RunE: func(cmd *cobra.Command, args []string) error {
			return printAuthStatus(ctx, opts)
		},
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show account status",
		RunE: func(cmd *cobra.Command, args []string) error {
			return printAuthStatus(ctx, opts)
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "billing",
		Short: "Show credits and entitlements",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			token, _ := grikauth.AccessToken(store.Get())
			if token == "" {
				return fmt.Errorf("not signed in; run `ricochet login`")
			}
			reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			defer cancel()
			billing, err := grikauth.NewClient().Billing(reqCtx, token)
			if err != nil {
				return err
			}
			writeJSON(os.Stdout, billing)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "models",
		Short: "List subscription models",
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, _, err := loadProvidersForCLI(false)
			if err != nil {
				return err
			}
			for _, provider := range pm.GetAvailableProviders() {
				if provider.ID == "grik" {
					printProviderModels(provider, config.Settings{})
					return nil
				}
			}
			return fmt.Errorf("subscription provider `grik` is not configured")
		},
	})
	return cmd
}

func newProvidersCommand(opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "providers", Short: "Inspect and configure providers"}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List providers, availability, and key sources",
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, settings, err := loadProvidersForCLI(false)
			if err != nil {
				return err
			}
			if opts.jsonOut {
				writeJSON(os.Stdout, pm.GetAvailableProviders())
				return nil
			}
			printProviders(pm.GetAvailableProviders(), settings)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "set <provider>",
		Short: "Set default provider and a recommended model",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, _, err := loadProvidersForCLI(false)
			if err != nil {
				return err
			}
			for _, provider := range pm.GetAvailableProviders() {
				if provider.ID == args[0] {
					model := preferredCLIModel(provider)
					if model == "" {
						return fmt.Errorf("provider %q has no models", args[0])
					}
					if err := setProviderModel(args[0], model); err != nil {
						return err
					}
					fmt.Printf("provider: %s\nmodel: %s\n", args[0], model)
					return nil
				}
			}
			return fmt.Errorf("provider %q not found", args[0])
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "doctor [provider]",
		Short: "Show provider readiness",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, settings, err := loadProvidersForCLI(false)
			if err != nil {
				return err
			}
			providers := pm.GetAvailableProviders()
			if len(args) > 0 {
				for _, provider := range providers {
					if provider.ID == args[0] {
						printProviderDoctor(provider, settings)
						return nil
					}
				}
				return fmt.Errorf("provider %q not found", args[0])
			}
			for _, provider := range providers {
				printProviderDoctor(provider, settings)
			}
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "test <provider>",
		Short: "Check configured key and catalog availability for a provider",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, settings, err := loadProvidersForCLI(false)
			if err != nil {
				return err
			}
			for _, provider := range pm.GetAvailableProviders() {
				if provider.ID == args[0] {
					printProviderDoctor(provider, settings)
					return nil
				}
			}
			return fmt.Errorf("provider %q not found", args[0])
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "models <provider>",
		Short: "List models for one provider",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, settings, err := loadProvidersForCLI(false)
			if err != nil {
				return err
			}
			for _, provider := range pm.GetAvailableProviders() {
				if provider.ID == args[0] {
					printProviderModels(provider, settings)
					return nil
				}
			}
			return fmt.Errorf("provider %q not found", args[0])
		},
	})
	cmd.AddCommand(newProviderKeyCommand(opts))
	return cmd
}

func newProviderKeyCommand(opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "key", Short: "Manage BYOK provider keys"}
	cmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show configured BYOK keys",
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, settings, err := loadProvidersForCLI(false)
			if err != nil {
				return err
			}
			if opts.jsonOut {
				status := map[string]string{}
				for _, provider := range pm.GetAvailableProviders() {
					status[provider.ID] = keyStatus(settings.Provider.APIKeys[provider.ID])
				}
				writeJSON(os.Stdout, status)
				return nil
			}
			for _, provider := range pm.GetAvailableProviders() {
				fmt.Printf("%s: %s\n", provider.ID, keyStatus(settings.Provider.APIKeys[provider.ID]))
			}
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "set <provider> <key>",
		Short: "Save a BYOK key for a provider",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return setProviderKey(args[0], args[1])
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "remove <provider>",
		Short: "Remove a BYOK key for a provider",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return setProviderKey(args[0], "")
		},
	})
	return cmd
}

func newModelsCommand(opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "models", Short: "Inspect and select models"}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List configured providers and models",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			pm, err := config.NewProvidersManager(config.FindConfigFile())
			if err != nil {
				return err
			}
			settings := store.Get()
			for providerID, key := range settings.Provider.APIKeys {
				pm.SetUserKey(providerID, key)
			}
			if !strings.EqualFold(os.Getenv("RICOCHET_DISABLE_OPENROUTER_MODEL_SYNC"), "1") {
				syncCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_ = pm.RefreshOpenRouterFreeModels(syncCtx)
				cancel()
			}
			for _, provider := range pm.GetAvailableProviders() {
				status := "unavailable"
				if provider.Available {
					status = "available"
				}
				fmt.Printf("%s (%s, key=%s", provider.ID, status, provider.KeySource)
				if provider.AccessMode != "" {
					fmt.Printf(", access=%s", provider.AccessMode)
				}
				fmt.Println(")")
				for _, model := range provider.Models {
					marker := " "
					if settings.Provider.Provider == provider.ID && settings.Provider.Model == model.ID {
						marker = "*"
					}
					fmt.Printf("  %s %s", marker, model.ID)
					if model.Name != "" {
						fmt.Printf(" - %s", model.Name)
					}
					if model.IsFree {
						fmt.Print(" [free]")
					}
					if model.RequiresSubscription || model.AccessMode == "subscription" {
						fmt.Print(" [subscription]")
					}
					if model.Limited {
						fmt.Print(" [limited]")
					}
					if model.Deprecated {
						fmt.Print(" [deprecated]")
					}
					fmt.Println()
				}
			}
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "set <provider> <model>",
		Short: "Set the default provider and model",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return setProviderModel(args[0], args[1])
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "current",
		Short: "Show the active default provider and model",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			settings := store.Get()
			if opts.jsonOut {
				writeJSON(os.Stdout, map[string]string{
					"provider": settings.Provider.Provider,
					"model":    settings.Provider.Model,
				})
				return nil
			}
			fmt.Printf("provider: %s\nmodel: %s\n", settings.Provider.Provider, settings.Provider.Model)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "pick",
		Short: "Print grouped model picker options",
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, settings, err := loadProvidersForCLI(false)
			if err != nil {
				return err
			}
			printModelPicker(pm.GetAvailableProviders(), settings)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "refresh",
		Short: "Refresh OpenRouter free model catalog, then list models",
		RunE: func(cmd *cobra.Command, args []string) error {
			pm, settings, err := loadProvidersForCLI(true)
			if err != nil {
				return err
			}
			printModelPicker(pm.GetAvailableProviders(), settings)
			return nil
		},
	})
	return cmd
}

func newPermissionsCommand(opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "permissions", Short: "Manage persistent permission rules"}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List permission rules and audit entries",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := safeguard.NewPermissionStore()
			if err != nil {
				return err
			}
			writeJSON(os.Stdout, redactSecrets(map[string]interface{}{
				"rules": store.ListRules(),
				"audit": store.ListAudit(),
			}))
			return nil
		},
	})
	var addTool, addPath, addCommandPrefix, addAction, addScope string
	add := &cobra.Command{
		Use:   "add",
		Short: "Add an allow/deny rule",
		RunE: func(cmd *cobra.Command, args []string) error {
			if addTool == "" {
				return fmt.Errorf("--tool is required")
			}
			store, err := safeguard.NewPermissionStore()
			if err != nil {
				return err
			}
			return store.AddRule(safeguard.PermissionRule{
				Tool:          addTool,
				Path:          addPath,
				CommandPrefix: addCommandPrefix,
				Action:        firstNonEmptyString(addAction, "allow"),
				Scope:         safeguard.PermissionScope(firstNonEmptyString(addScope, string(safeguard.ScopeProject))),
				Project:       opts.cwd,
				SessionID:     opts.sessionID,
			})
		},
	}
	add.Flags().StringVar(&addTool, "tool", "", "tool name, e.g. execute_command")
	add.Flags().StringVar(&addPath, "path", "", "path/glob target")
	add.Flags().StringVar(&addCommandPrefix, "command-prefix", "", "allowed command prefix")
	add.Flags().StringVar(&addAction, "action", "allow", "allow or deny")
	add.Flags().StringVar(&addScope, "scope", string(safeguard.ScopeProject), "global, project, or session")
	cmd.AddCommand(add)
	cmd.AddCommand(&cobra.Command{
		Use:   "remove <rule-id>",
		Short: "Remove a permission rule",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := safeguard.NewPermissionStore()
			if err != nil {
				return err
			}
			return store.RemoveRule(args[0])
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "mode <ask|auto|full>",
		Short: "Set coarse approval mode",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return setApprovalMode(args[0])
		},
	})
	return cmd
}

func newMCPCommand(opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "mcp", Short: "Manage MCP server settings"}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List MCP servers",
		RunE: func(cmd *cobra.Command, args []string) error {
			servers, err := mcpManager().ListServers()
			if err != nil {
				return err
			}
			writeJSON(os.Stdout, servers)
			return nil
		},
	})
	var addURL string
	add := &cobra.Command{
		Use:   "add <name> [command] [args...]",
		Short: "Add an MCP server",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := mcp.McpServerConfig{}
			if addURL != "" {
				cfg.Type = "sse"
				cfg.URL = addURL
			} else {
				if len(args) < 2 {
					return fmt.Errorf("command is required unless --url is set")
				}
				cfg.Type = "stdio"
				cfg.Command = args[1]
				cfg.Args = args[2:]
			}
			return mcpManager().AddServer(args[0], cfg)
		},
	}
	add.Flags().StringVar(&addURL, "url", "", "remote MCP server URL")
	cmd.AddCommand(add)
	cmd.AddCommand(&cobra.Command{
		Use:   "remove <name>",
		Short: "Remove an MCP server",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return mcpManager().RemoveServer(args[0])
		},
	})
	cmd.AddCommand(mcpToggleCommand("enable", false))
	cmd.AddCommand(mcpToggleCommand("disable", true))
	return cmd
}

func newLiveCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "live", Aliases: []string{"ether"}, Short: "Manage Live/Ether mode"}
	cmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show Live/Ether status",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := requestAndPrint(ctx, opts, "get_live_mode_status", nil); err == nil {
				return nil
			}
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			writeJSON(os.Stdout, redactSecrets(store.Get().LiveMode))
			return nil
		},
	})
	cmd.AddCommand(liveToggleCommand(ctx, opts, "enable", true))
	cmd.AddCommand(liveToggleCommand(ctx, opts, "disable", false))
	cmd.AddCommand(&cobra.Command{
		Use:   "test",
		Short: "Show configured Live/Ether transport readiness",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			live := store.Get().LiveMode
			if live.TelegramToken == "" {
				return fmt.Errorf("telegram token is not configured")
			}
			fmt.Printf("Telegram token configured: yes\nTelegram chat ID: %d\n", live.TelegramChatID)
			return nil
		},
	})
	return cmd
}

func newCheckpointCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	cmd := &cobra.Command{Use: "checkpoint", Short: "Inspect and restore checkpoints"}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List checkpoints",
		RunE: func(cmd *cobra.Command, args []string) error {
			return requestAndPrint(ctx, opts, "checkpoint_list", nil)
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "preview <hash>",
		Short: "Preview checkpoint restore",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return requestAndPrint(ctx, opts, "checkpoint_preview_restore", map[string]string{"checkpoint_hash": args[0]})
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "restore <hash>",
		Short: "Restore a checkpoint",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return requestAndPrint(ctx, opts, "checkpoint_restore", map[string]interface{}{
				"checkpoint_hash":          args[0],
				"mode":                     "full",
				"create_safety_checkpoint": true,
			})
		},
	})
	return cmd
}

func newReviewCommand(ctx context.Context, opts *cliOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "review [scope]",
		Short: "Ask Ricochet to review the current workspace or a scope",
		Args:  cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			scope := strings.TrimSpace(strings.Join(args, " "))
			if scope == "" {
				scope = "the current workspace changes"
			}
			return runPromptCommand(ctx, opts, "Review "+scope+". Prioritize bugs, regressions, security risks, and missing tests. Return findings first with file and line references where possible.")
		},
	}
}

func newDoctorCommand(opts *cliOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check CLI, daemon, config, and workspace readiness",
		RunE: func(cmd *cobra.Command, args []string) error {
			return printConfigDoctor()
		},
	}
}

func runServerCommand(ctx context.Context, opts *cliOptions, daemon bool) error {
	cwd, err := prepareCWD(opts.cwd)
	if err != nil {
		return err
	}
	if err := applyGlobalSettings(opts); err != nil {
		return err
	}
	pm, err := initRuntime(cwd)
	if err != nil {
		return err
	}
	runServerMode(ctx, cwd, opts.port, daemon, pm)
	return nil
}

func runStdioCommand(ctx context.Context, opts *cliOptions) error {
	cwd, err := prepareCWD(opts.cwd)
	if err != nil {
		return err
	}
	if err := applyGlobalSettings(opts); err != nil {
		return err
	}
	pm, err := initRuntime(cwd)
	if err != nil {
		return err
	}
	runStdioMode(ctx, cwd, pm)
	return nil
}

func runTUICommand(ctx context.Context, opts *cliOptions) error {
	cwd, err := prepareCWD(opts.cwd)
	if err != nil {
		return err
	}
	if err := applyGlobalSettings(opts); err != nil {
		return err
	}
	runInteractiveMode(ctx, cwd)
	return nil
}

func runInteractiveChat(ctx context.Context, opts *cliOptions) error {
	reader := bufio.NewReader(os.Stdin)
	fmt.Printf("Connected daemon: %s\n", opts.serverAddr)
	fmt.Println("Type exit or quit to leave.")
	for {
		fmt.Print("You > ")
		text, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if text == "exit" || text == "quit" {
			return nil
		}
		if err := runPromptCommand(ctx, opts, text); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
		}
	}
}

func runPromptCommand(ctx context.Context, opts *cliOptions, prompt string) error {
	if err := applyGlobalSettings(opts); err != nil {
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	client, err := dialRPC(reqCtx, opts.serverAddr)
	if err != nil {
		return fmt.Errorf("connect to daemon %s: %w (start it with `ricochet daemon start`)", opts.serverAddr, err)
	}
	defer client.close()

	if _, err := client.request(reqCtx, "create_session", map[string]string{"session_id": opts.sessionID}); err != nil {
		return err
	}
	requestID := client.nextID()
	if err := client.send(requestID, "chat_message", map[string]interface{}{
		"content":    prompt,
		"session_id": opts.sessionID,
		"via":        "cli",
		"run_id":     fmt.Sprintf("cli-%d", time.Now().UnixMilli()),
	}); err != nil {
		return err
	}
	return streamChat(ctx, client, os.Stdout, requestID, streamRenderOptions{
		jsonOut: opts.jsonOut,
		jsonl:   opts.jsonl,
		noColor: opts.noColor,
	})
}

func requestAndPrint(ctx context.Context, opts *cliOptions, method string, payload interface{}) error {
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	client, err := dialRPC(reqCtx, opts.serverAddr)
	if err != nil {
		return fmt.Errorf("connect to daemon %s: %w", opts.serverAddr, err)
	}
	defer client.close()
	msg, err := client.request(reqCtx, method, payload)
	if err != nil {
		return err
	}
	writeJSON(os.Stdout, msg)
	return nil
}

func printDaemonStatus(ctx context.Context, opts *cliOptions) error {
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	client, err := dialRPC(reqCtx, opts.serverAddr)
	if err != nil {
		fmt.Printf("daemon: unreachable (%v)\n", err)
		if pid, pidErr := readDaemonPID(); pidErr == nil {
			fmt.Printf("pid file: %d\n", pid)
		}
		return nil
	}
	defer client.close()
	msg, err := client.request(reqCtx, "health_check", nil)
	if err != nil {
		return err
	}
	writeJSON(os.Stdout, msg)
	return nil
}

func stopDaemon() error {
	pid, err := readDaemonPID()
	if err != nil {
		return err
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := process.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	fmt.Printf("sent SIGTERM to Ricochet daemon pid %d\n", pid)
	return nil
}

func readDaemonPID() (int, error) {
	data, err := os.ReadFile(filepath.Join(paths.GetGlobalDir(), "core.pid"))
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(data)))
}

func prepareCWD(value string) (string, error) {
	if value == "" {
		value = "."
	}
	abs, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	if err := os.Chdir(abs); err != nil {
		return "", err
	}
	return abs, nil
}

func applyGlobalSettings(opts *cliOptions) error {
	if opts.noColor {
		os.Setenv("RICOCHET_NO_COLOR", "1")
	}
	if opts.model == "" && opts.provider == "" && opts.approvalMode == "" && len(opts.configOverrides) == 0 && !opts.live {
		return nil
	}
	store, err := config.NewStore()
	if err != nil {
		return err
	}
	for _, override := range opts.configOverrides {
		key, value, ok := strings.Cut(override, "=")
		if !ok {
			return fmt.Errorf("--config expects key=value, got %q", override)
		}
		if err := updateSettingWithStore(store, key, value); err != nil {
			return err
		}
	}
	return store.Update(func(s *config.Settings) {
		if opts.provider != "" {
			s.Provider.Provider = opts.provider
		}
		if opts.model != "" {
			s.Provider.Model = opts.model
		}
		if opts.approvalMode != "" {
			applyApprovalMode(s, opts.approvalMode)
		}
		if opts.live {
			s.LiveMode.Enabled = true
		}
	})
}

func updateSetting(key, rawValue string) error {
	store, err := config.NewStore()
	if err != nil {
		return err
	}
	return updateSettingWithStore(store, key, rawValue)
}

func updateSettingWithStore(store *config.Store, key, rawValue string) error {
	value := parseSettingValue(rawValue)
	return store.Update(func(s *config.Settings) {
		var data map[string]interface{}
		encoded, _ := json.Marshal(s)
		_ = json.Unmarshal(encoded, &data)
		setDottedValue(data, key, value)
		decoded, _ := json.Marshal(data)
		_ = json.Unmarshal(decoded, s)
	})
}

func setProviderModel(provider, model string) error {
	store, err := config.NewStore()
	if err != nil {
		return err
	}
	return store.Update(func(s *config.Settings) {
		s.Provider.Provider = provider
		s.Provider.Model = model
	})
}

func setProviderKey(provider, key string) error {
	store, err := config.NewStore()
	if err != nil {
		return err
	}
	if provider == "grik" {
		if key == "" {
			os.Unsetenv("GRIKAI_ACCESS_TOKEN")
		} else {
			os.Setenv("GRIKAI_ACCESS_TOKEN", key)
		}
	}
	return store.Update(func(s *config.Settings) {
		if s.Provider.APIKeys == nil {
			s.Provider.APIKeys = make(map[string]string)
		}
		if key == "" {
			delete(s.Provider.APIKeys, provider)
			if s.Provider.Provider == provider {
				s.Provider.APIKey = ""
			}
			if provider == "grik" {
				s.Auth.GrikAccessToken = ""
				s.Auth.GrikRefreshToken = ""
				s.Auth.GrikExpiresAt = 0
			}
			return
		}
		s.Provider.APIKeys[provider] = key
		if s.Provider.Provider == provider {
			s.Provider.APIKey = key
		}
		if provider == "grik" {
			s.Auth.GrikAccessToken = key
		}
	})
}

func loadProvidersForCLI(syncFree bool) (*config.ProvidersManager, config.Settings, error) {
	store, err := config.NewStore()
	if err != nil {
		return nil, config.Settings{}, err
	}
	settings := store.Get()
	pm, err := config.NewProvidersManager(config.FindConfigFile())
	if err != nil {
		return nil, config.Settings{}, err
	}
	for providerID, key := range settings.Provider.APIKeys {
		pm.SetUserKey(providerID, key)
	}
	if settings.Provider.APIKey != "" && settings.Provider.Provider != "" {
		pm.SetUserKey(settings.Provider.Provider, settings.Provider.APIKey)
	}
	if syncFree && !strings.EqualFold(os.Getenv("RICOCHET_DISABLE_OPENROUTER_MODEL_SYNC"), "1") {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = pm.RefreshOpenRouterFreeModels(ctx)
		cancel()
	}
	return pm, settings, nil
}

func printAuthStatus(ctx context.Context, opts *cliOptions) error {
	store, err := config.NewStore()
	if err != nil {
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	status := grikauth.Status(reqCtx, store)
	if opts.jsonOut {
		writeJSON(os.Stdout, status)
		return nil
	}
	fmt.Printf("authenticated: %v\n", status.Authenticated)
	fmt.Printf("token source: %s\n", firstNonEmptyString(status.TokenSource, "none"))
	fmt.Printf("api: %s\n", status.APIBaseURL)
	if len(status.User) > 0 {
		if user := firstInterfaceString(status.User, "email", "username", "name", "id"); user != "" {
			fmt.Printf("user: %s\n", user)
		}
	}
	return nil
}

func printProviders(providers []config.AvailableProvider, settings config.Settings) {
	for _, provider := range providers {
		printProviderDoctor(provider, settings)
	}
}

func printProviderDoctor(provider config.AvailableProvider, settings config.Settings) {
	current := ""
	if settings.Provider.Provider == provider.ID {
		current = " current"
	}
	status := "unavailable"
	if provider.Available {
		status = "available"
	}
	fmt.Printf("%s%s\n", provider.ID, current)
	fmt.Printf("  status: %s\n", status)
	fmt.Printf("  key: %s (%s)\n", keyStatus(settings.Provider.APIKeys[provider.ID]), firstNonEmptyString(provider.KeySource, "none"))
	fmt.Printf("  access: %s\n", firstNonEmptyString(provider.AccessMode, "byok"))
	fmt.Printf("  models: %d\n", len(provider.Models))
}

func printProviderModels(provider config.AvailableProvider, settings config.Settings) {
	fmt.Printf("%s (%s)\n", provider.ID, firstNonEmptyString(provider.AccessMode, "byok"))
	for _, model := range provider.Models {
		marker := " "
		if settings.Provider.Provider == provider.ID && settings.Provider.Model == model.ID {
			marker = "*"
		}
		fmt.Printf("  %s %s", marker, model.ID)
		if model.Name != "" {
			fmt.Printf(" - %s", model.Name)
		}
		tags := modelTags(provider, model)
		if len(tags) > 0 {
			fmt.Printf(" [%s]", strings.Join(tags, ", "))
		}
		fmt.Println()
	}
}

func printModelPicker(providers []config.AvailableProvider, settings config.Settings) {
	groups := []string{"Free", "BYOK", "Subscription", "Limited", "Deprecated"}
	byGroup := map[string][]string{}
	for _, provider := range providers {
		for _, model := range provider.Models {
			group := cliModelGroup(provider, model)
			marker := " "
			if settings.Provider.Provider == provider.ID && settings.Provider.Model == model.ID {
				marker = "*"
			}
			line := fmt.Sprintf("%s %s:%s", marker, provider.ID, model.ID)
			if model.Name != "" {
				line += " - " + model.Name
			}
			tags := modelTags(provider, model)
			if len(tags) > 0 {
				line += " [" + strings.Join(tags, ", ") + "]"
			}
			byGroup[group] = append(byGroup[group], line)
		}
	}
	fmt.Println("Use `ricochet models set <provider> <model>` to select.")
	for _, group := range groups {
		lines := byGroup[group]
		if len(lines) == 0 {
			continue
		}
		fmt.Printf("\n%s\n", group)
		limit := len(lines)
		if limit > 25 {
			limit = 25
		}
		for _, line := range lines[:limit] {
			fmt.Println(" ", line)
		}
		if len(lines) > limit {
			fmt.Printf("  ...and %d more\n", len(lines)-limit)
		}
	}
}

func preferredCLIModel(provider config.AvailableProvider) string {
	for _, model := range provider.Models {
		if model.Recommended && !model.Deprecated && !model.Limited {
			return model.ID
		}
	}
	for _, model := range provider.Models {
		if !model.Deprecated && !model.Limited {
			return model.ID
		}
	}
	if len(provider.Models) == 0 {
		return ""
	}
	return provider.Models[0].ID
}

func cliModelGroup(provider config.AvailableProvider, model config.AvailableModel) string {
	switch {
	case model.Deprecated:
		return "Deprecated"
	case model.Limited:
		return "Limited"
	case model.RequiresSubscription || model.AccessMode == "subscription" || provider.AccessMode == "subscription":
		return "Subscription"
	case model.IsFree || model.AccessMode == "free":
		return "Free"
	default:
		return "BYOK"
	}
}

func modelTags(provider config.AvailableProvider, model config.AvailableModel) []string {
	tags := []string{}
	if model.IsFree || model.AccessMode == "free" {
		tags = append(tags, "free")
	}
	if model.RequiresSubscription || model.AccessMode == "subscription" || provider.AccessMode == "subscription" {
		tags = append(tags, "subscription")
	}
	if model.Limited {
		tags = append(tags, "limited")
	}
	if model.Deprecated {
		tags = append(tags, "deprecated")
	}
	if model.SupportsTools {
		tags = append(tags, "tools")
	}
	return tags
}

func firstInterfaceString(data map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := data[key]; ok {
			text := strings.TrimSpace(fmt.Sprint(value))
			if text != "" {
				return text
			}
		}
	}
	return ""
}

func redactTokenForOutput(token string, show bool) string {
	if token == "" {
		return ""
	}
	if show {
		return token
	}
	if len(token) <= 10 {
		return "***"
	}
	return token[:4] + "..." + token[len(token)-4:]
}

func setApprovalMode(mode string) error {
	store, err := config.NewStore()
	if err != nil {
		return err
	}
	return store.Update(func(s *config.Settings) {
		applyApprovalMode(s, mode)
	})
}

func applyApprovalMode(s *config.Settings, mode string) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "ask", "manual", "default":
		s.AutoApproval.Enabled = false
	case "auto", "safe":
		s.AutoApproval.Enabled = true
		s.AutoApproval.ReadFiles = true
		s.AutoApproval.ExecuteSafeCommands = true
	case "full", "danger", "dangerous":
		s.AutoApproval.Enabled = true
		s.AutoApproval.ReadFiles = true
		s.AutoApproval.EditFiles = true
		s.AutoApproval.ExecuteSafeCommands = true
		s.AutoApproval.ExecuteAllCommands = true
		s.AutoApproval.UseMCP = true
	}
}

func parseSettingValue(raw string) interface{} {
	var value interface{}
	if err := json.Unmarshal([]byte(raw), &value); err == nil {
		return value
	}
	if b, err := strconv.ParseBool(raw); err == nil {
		return b
	}
	if i, err := strconv.Atoi(raw); err == nil {
		return i
	}
	if f, err := strconv.ParseFloat(raw, 64); err == nil {
		return f
	}
	return raw
}

func setDottedValue(data map[string]interface{}, path string, value interface{}) {
	parts := strings.Split(path, ".")
	current := data
	for _, part := range parts[:len(parts)-1] {
		next, ok := current[part].(map[string]interface{})
		if !ok {
			next = map[string]interface{}{}
			current[part] = next
		}
		current = next
	}
	current[parts[len(parts)-1]] = value
}

func getDottedValue(value interface{}, path string) (interface{}, bool) {
	var data map[string]interface{}
	encoded, _ := json.Marshal(value)
	if err := json.Unmarshal(encoded, &data); err != nil {
		return nil, false
	}
	var current interface{} = data
	for _, part := range strings.Split(path, ".") {
		asMap, ok := current.(map[string]interface{})
		if !ok {
			return nil, false
		}
		current, ok = asMap[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func redactSecrets(value interface{}) interface{} {
	data, _ := json.Marshal(value)
	var out interface{}
	_ = json.Unmarshal(data, &out)
	redactRecursive(out)
	return out
}

func redactRecursive(value interface{}) {
	switch v := value.(type) {
	case map[string]interface{}:
		for key, item := range v {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "key") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") {
				if s, ok := item.(string); ok && s != "" {
					v[key] = "***"
				}
				continue
			}
			redactRecursive(item)
		}
	case []interface{}:
		for _, item := range v {
			redactRecursive(item)
		}
	}
}

func editFile(path string) error {
	editor := os.Getenv("EDITOR")
	if editor == "" {
		editor = "vi"
	}
	cmd := exec.Command(editor, path)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func printConfigDoctor() error {
	store, err := config.NewStore()
	if err != nil {
		return err
	}
	settings := store.Get()
	fmt.Printf("settings: %s\n", filepath.Join(paths.GetGlobalDir(), "settings.json"))
	fmt.Printf("provider: %s\n", settings.Provider.Provider)
	fmt.Printf("model: %s\n", settings.Provider.Model)
	fmt.Printf("provider key: %s\n", keyStatus(settings.Provider.APIKey, settings.Provider.APIKeys[settings.Provider.Provider]))
	fmt.Printf("live mode: enabled=%v telegram_token=%s chat_id=%d\n", settings.LiveMode.Enabled, keyStatus(settings.LiveMode.TelegramToken), settings.LiveMode.TelegramChatID)
	fmt.Printf("mcp settings: %s\n", filepath.Join(paths.GetGlobalDir(), "mcp_settings.json"))
	fmt.Printf("permissions: %s\n", filepath.Join(paths.GetGlobalDir(), "permissions.json"))
	fmt.Printf("terminal output line limit: %d\n", settings.Terminal.OutputLineLimit)
	return nil
}

func keyStatus(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return "configured"
		}
	}
	return "missing"
}

func mcpManager() *mcp.Manager {
	return mcp.NewManager(paths.GetGlobalDir())
}

func mcpToggleCommand(name string, disabled bool) *cobra.Command {
	return &cobra.Command{
		Use:   name + " <server-name>",
		Short: strings.Title(name) + " an MCP server",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			manager := mcpManager()
			settings, err := manager.LoadSettings()
			if err != nil {
				return err
			}
			cfg, ok := settings.McpServers[args[0]]
			if !ok {
				return fmt.Errorf("MCP server %q not found", args[0])
			}
			cfg.Disabled = disabled
			settings.McpServers[args[0]] = cfg
			return manager.SaveSettings(settings)
		},
	}
}

func liveToggleCommand(ctx context.Context, opts *cliOptions, name string, enabled bool) *cobra.Command {
	return &cobra.Command{
		Use:   name,
		Short: strings.Title(name) + " Live/Ether mode",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := config.NewStore()
			if err != nil {
				return err
			}
			if err := store.Update(func(s *config.Settings) { s.LiveMode.Enabled = enabled }); err != nil {
				return err
			}
			if err := requestAndPrint(ctx, opts, "set_live_mode", map[string]bool{"enabled": enabled}); err == nil {
				return nil
			}
			fmt.Printf("live mode setting saved: enabled=%v (daemon is not reachable)\n", enabled)
			return nil
		},
	}
}
