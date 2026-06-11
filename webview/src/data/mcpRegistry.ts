export interface McpRegistryItem {
    id: string;
    name: string;
    description: string;
    category: 'search' | 'tools' | 'communication' | 'database' | 'other';
    command: string;
    args: string[];
    envVars?: string[];
    logoUrl?: string;
    githubUrl?: string;
}

export const MCP_REGISTRY: McpRegistryItem[] = [
    {
        id: "brave-search",
        name: "Brave Search",
        description: "Search the web using the Brave Search API. High-quality privacy-focused results.",
        category: "search",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search"],
        envVars: ["BRAVE_API_KEY"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search"
    },
    {
        id: "github",
        name: "GitHub",
        description: "Interact with GitHub: manage issues, PRs, and read repositories.",
        category: "tools",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github"
    },
    {
        id: "memory",
        name: "Memory",
        description: "Knowledge graph based persistent memory for the AI agent.",
        category: "other",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory"
    },
    {
        id: "google-maps",
        name: "Google Maps",
        description: "Search for places and get details using Google Maps API.",
        category: "search",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-google-maps"],
        envVars: ["GOOGLE_MAPS_API_KEY"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps"
    },
    {
        id: "postgres",
        name: "PostgreSQL",
        description: "Connect to PostgreSQL databases to query and manage data.",
        category: "database",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        envVars: ["DATABASE_URL"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres"
    },
    {
        id: "slack",
        name: "Slack",
        description: "Send and receive messages from Slack channels.",
        category: "communication",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-slack"],
        envVars: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack"
    },
    {
        id: "figma",
        name: "Figma",
        description: "Interact with Figma files, retrieve styles, and manage comments.",
        category: "tools",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-figma"],
        envVars: ["FIGMA_ACCESS_TOKEN"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/figma"
    },
    {
        id: "sqlite",
        name: "SQLite",
        description: "Query and manage local SQLite databases.",
        category: "database",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sqlite"],
        envVars: ["SQLITE_DB_PATH"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite"
    },
    {
        id: "obsidian",
        name: "Obsidian",
        description: "Interact with your Obsidian vaults: search, read, and write notes.",
        category: "other",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-obsidian"],
        envVars: ["OBSIDIAN_API_KEY"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/obsidian"
    },
    {
        id: "linear",
        name: "Linear",
        description: "Manage Linear issues, projects, and cycles.",
        category: "tools",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-linear"],
        envVars: ["LINEAR_API_KEY"],
        githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/linear"
    }
];
