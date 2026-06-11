/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                // VSCode theme integration (Legacy Ricochet)
                'vscode-bg': 'var(--vscode-editor-background)',
                'vscode-fg': 'var(--vscode-editor-foreground)',
                'vscode-border': 'var(--vscode-panel-border)',
                'vscode-sideBar-bg': 'var(--vscode-sideBar-background)',
                'vscode-input-bg': 'var(--vscode-input-background)',
                'vscode-input-fg': 'var(--vscode-input-foreground)',
                'vscode-button-bg': 'var(--vscode-button-background)',
                'vscode-button-fg': 'var(--vscode-button-foreground)',
                'vscode-button-hover': 'var(--vscode-button-hoverBackground)',
                'vscode-dropdown-bg': 'var(--vscode-dropdown-background)',
                'vscode-dropdown-fg': 'var(--vscode-dropdown-foreground)',
                'vscode-toolbar-hover': 'var(--vscode-toolbar-hoverBackground)',
                'vscode-editor-background': 'var(--vscode-editor-background)',
                // Muted brand colors (Legacy Ricochet)
                'ricochet-primary': '#4ade80',
                'ricochet-secondary': '#94a3b8',
                'ricochet-accent': '#38bdf8',
                'ricochet-muted': 'rgba(255, 255, 255, 0.06)',
                'ricochet-subtle': 'rgba(255, 255, 255, 0.03)',
                // Live mode
                'live-mode': '#22c55e',
                'live-mode-glow': '#4ade80',

                // --- Ported from Cline (UI Kit Support) ---
                background: "var(--vscode-editor-background)",
                border: {
                    DEFAULT: "var(--vscode-focusBorder)",
                    panel: "var(--vscode-panel-border)",
                },
                foreground: "var(--vscode-foreground)",
                shadow: "var(--vscode-widget-shadow)",
                code: {
                    background: "var(--vscode-editor-background)",
                    foreground: "var(--vscode-editor-foreground)",
                    border: "var(--vscode-editor-border)",
                },
                sidebar: {
                    background: "var(--vscode-sideBar-background)",
                    foreground: "var(--vscode-sideBar-foreground)",
                },
                input: {
                    foreground: "var(--vscode-input-foreground)",
                    background: "var(--vscode-input-background)",
                    border: "var(--vscode-input-border)",
                    placeholder: "var(--vscode-input-placeholderForeground)",
                },
                selection: {
                    DEFAULT: "var(--vscode-list-activeSelectionBackground)",
                    foreground: "var(--vscode-list-activeSelectionForeground)",
                },
                button: {
                    background: {
                        DEFAULT: "var(--vscode-button-background)",
                        hover: "var(--vscode-button-hoverBackground)",
                    },
                    foreground: "var(--vscode-button-foreground)",
                    separator: "var(--vscode-button-separator)",
                    secondary: {
                        background: {
                            DEFAULT: "var(--vscode-button-secondaryBackground)",
                            hover: "var(--vscode-button-secondaryHoverBackground)",
                        },
                        foreground: "var(--vscode-button-secondaryForeground)",
                    },
                },
                muted: {
                    DEFAULT: "var(--vscode-editor-foldBackground)",
                    foreground: "var(--vscode-editor-foldPlaceholderForeground)",
                },
                menu: {
                    DEFAULT: "var(--vscode-menu-background)",
                    foreground: "var(--vscode-menu-foreground)",
                    border: "var(--vscode-menu-border)",
                    shadow: "var(--vscode-menu-shadow)",
                },
                link: {
                    DEFAULT: "var(--vscode-textLink-foreground)",
                    hover: "var(--vscode-textLink-activeForeground)",
                },
                list: {
                    background: {
                        hover: "var(--vscode-list-hoverBackground)",
                    },
                },
                badge: {
                    foreground: "var(--vscode-badge-foreground)",
                    background: "var(--vscode-badge-background)",
                },
                banner: {
                    background: "var(--vscode-banner-background)",
                    foreground: "var(--vscode-banner-foreground)",
                    icon: "var(--vscode-banner-iconForeground)",
                },
                toolbar: {
                    DEFAULT: "var(--vscode-toolbar-background)",
                    hover: "var(--vscode-toolbar-hoverBackground)",
                },
                error: "var(--vscode-errorForeground)",
                description: "var(--vscode-descriptionForeground)",
                success: "var(--vscode-charts-green)",
                warning: "var(--vscode-charts-yellow)",
                // --- Cyber-Specter (Premium Upgrade) ---
                'cyber-cyan': '#00D1FF',
                'cyber-purple': '#7000FF',
                'cyber-bg': 'rgba(10, 10, 20, 0.8)',
                'cyber-glass': 'rgba(255, 255, 255, 0.03)',
                'cyber-border': 'rgba(0, 209, 255, 0.2)',
            },
            boxShadow: {
                'inner-vscode': 'inset 0 1px 2px rgba(0, 0, 0, 0.3)',
                'outer-soft': '0 2px 8px rgba(0, 0, 0, 0.15)',
                'live-mode-glow': '0 0 20px rgba(34, 197, 94, 0.4)',
                'cyber-glow': '0 0 20px rgba(0, 209, 255, 0.3)',
                'cyber-glow-strong': '0 0 40px rgba(0, 209, 255, 0.5)',
            },
            animation: {
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'glow': 'glow 2s ease-in-out infinite alternate',
                'fade-in': 'fadeIn 0.3s ease-out',
                'float': 'float 6s ease-in-out infinite',
                'cyber-pulse': 'cyberPulse 4s ease-in-out infinite',
            },
            keyframes: {
                glow: {
                    '0%': { boxShadow: '0 0 5px var(--tw-shadow-color)' },
                    '100%': { boxShadow: '0 0 20px var(--tw-shadow-color)' }
                },
                fadeIn: {
                    '0%': { opacity: '0', transform: 'translateY(4px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' }
                },
                float: {
                    '0%, 100%': { transform: 'translateY(0)' },
                    '50%': { transform: 'translateY(-10px)' }
                },
                cyberPulse: {
                    '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
                    '50%': { opacity: '0.8', transform: 'scale(1.05)' }
                }
            }
        },
    },
    plugins: [],
}
