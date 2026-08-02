export interface Tip {
  title: string
  body: string
  command?: string
  // DOM id of a Settings section to jump to instead of showing a CLI command,
  // for tips that are actually app features, not shell invocations.
  settingsSection?: string
}

// Mirrors mountos-servers' get_tips MCP tool (cmd/mfuse/mcp_tools_guidance.go)
// so CLI, MCP, and this app all surface the same curated set. Keep in sync
// when tips change there.
export const TIPS: Tip[] = [
  { title: 'Fast listing', body: 'List a directory with inode numbers fast. The inode column feeds Deleted files and Versions lookups.', command: 'ls -1i' },
  { title: 'Inode to path', body: 'Have an inode but not the name? ls -i shows it inline in any listing.', command: 'ls -i' },
  { title: 'Change events', body: "Stream a volume's live change-event feed (create/delete/modify/rename).", command: 'mountos event <mount-path>' },
  { title: 'Dashboard', body: 'Open the live TUI/GUI dashboard for a mount: stats, handles, deleted, diff, browse.', command: 'mountos dashboard <mount-path>' },
  { title: 'Deleted files', body: 'Browse and restore deleted items interactively, or use the Deleted files action in this app.', command: 'mountos deleted <mount-path>' },
  { title: 'Backends', body: 'Check which mount backends are available on this OS.', command: 'mountos check' },
  { title: 'File versions', body: "mountOS keeps one-minute file versions; view a file's history, or use the Versions action in this app.", command: 'mountos version <path>' },
  { title: 'Shell completion', body: 'Enable tab-completion for bash, zsh, fish, or powershell, then source the output.', command: 'mountos completion zsh' },
  { title: 'Man page', body: 'Read the full command reference (pipe to less for paging).', command: 'mountos man' },
  { title: 'MCP for AI agents', body: 'Register this mountos binary as a read-only MCP server for Claude Desktop, Claude Code, Codex, and Gemini.', settingsSection: 'settings-mcp' },
]
