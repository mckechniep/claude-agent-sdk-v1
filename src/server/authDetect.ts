import { access, constants } from "node:fs/promises";
import { join } from "node:path";

export interface AuthDetection {
  apiKeyDetected: boolean;
  subscriptionDetected: boolean;
}

const credentialsPath = (): string => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".claude", ".credentials.json");
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectAuth(originalApiKey: string | undefined): Promise<AuthDetection> {
  return {
    apiKeyDetected: typeof originalApiKey === "string" && originalApiKey.length > 0,
    subscriptionDetected: await fileExists(credentialsPath()),
  };
}
