export type MarketplaceItemType = 'mcp' | 'skill';
export type MarketplaceScope = 'project' | 'global';
export type MarketplaceTrust = 'verified' | 'community' | 'experimental';

export interface MarketplaceParameter {
    name: string;
    key?: string;
    label?: string;
    description?: string;
    placeholder?: string;
    env_var?: string;
    default?: string;
    required?: boolean;
    optional?: boolean;
    secret?: boolean;
}

export interface MarketplaceMcpInstallMethod {
    name?: string;
    transport?: string;
    command?: string;
    args?: string[];
    url?: string;
    env_vars?: string[];
    parameters?: MarketplaceParameter[];
    prerequisites?: string[];
}

export interface MarketplaceMcpPayload {
    install_methods?: MarketplaceMcpInstallMethod[];
    transport?: string;
    command?: string;
    args?: string[];
    url?: string;
    parameters?: MarketplaceParameter[];
    env_vars?: string[];
    prerequisites?: string[];
    tools?: string[];
    resources?: string[];
    prompts?: string[];
}

export interface MarketplaceSkillFile {
    path: string;
    content?: string;
    sha256?: string;
}

export interface MarketplaceSkillPayload {
    display_name?: string;
    skill_name: string;
    files?: MarketplaceSkillFile[];
    allowed_tools?: string[];
    implicit_invocation?: boolean;
    user_invocable?: boolean;
    dependencies?: string[];
}

export interface MarketplaceItem {
    id: string;
    type: MarketplaceItemType;
    name: string;
    description: string;
    version?: string;
    author?: string;
    tags?: string[];
    category?: string;
    trust?: MarketplaceTrust;
    source_url?: string;
    docs_url?: string;
    mcp?: MarketplaceMcpPayload;
    skill?: MarketplaceSkillPayload;
}

export interface MarketplaceCatalogResponse {
    items: MarketplaceItem[];
    last_synced?: string;
    source?: string;
    stale?: boolean;
    error?: string;
    item_count?: number;
    installed_count?: number;
}

export interface MarketplaceInstalledPath {
    path: string;
    sha256: string;
}

export interface MarketplaceInstalledItem {
    id: string;
    type: MarketplaceItemType;
    name: string;
    version?: string;
    scope: MarketplaceScope;
    paths?: MarketplaceInstalledPath[];
    config_name?: string;
    installed_at?: string;
}

export interface MarketplaceInstalledMetadata {
    project: MarketplaceInstalledItem[];
    global: MarketplaceInstalledItem[];
}

export interface MarketplaceInstallPayload {
    id: string;
    type: MarketplaceItemType;
    scope: MarketplaceScope;
    method?: string;
    parameters?: Record<string, string>;
}
