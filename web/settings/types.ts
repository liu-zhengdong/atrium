export type SettingsPage =
  "profile" | "accounts" | "agents" | "agent" | "agent-defaults" | "service";

export type Account = {
  id: string;
  provider: string;
  name: string;
  type: "api_key" | "oauth" | "local" | "setup_token";
  status: string;
  expires: number | null;
  last_error: string | null;
  credential_updated_at: number | null;
  assigned: string[];
};

export type Credentials = {
  mode: "shared" | "assigned";
  assigned: { provider: string; account: string }[];
};

export const matches = (
  query: string,
  ...parts: (string | undefined | null)[]
) =>
  !query ||
  parts.some((part) => part?.toLowerCase().includes(query.toLowerCase()));
