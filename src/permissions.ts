import type {
  PermissionHandler,
  PermissionRequest,
} from "@github/copilot-sdk" with { "resolution-mode": "import" };
import { describePermission } from "./presentation";

type PermissionPrompt = Parameters<PermissionHandler>[1]["promptRequest"];
type Description = ReturnType<typeof describePermission> & {
  approvalLabel?: string;
};

export function urlOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function requiresUser(value: PermissionRequest | PermissionPrompt): boolean {
  return Boolean(
    value &&
    (("managedApprovalRequired" in value && value.managedApprovalRequired) ||
      ("requestSandboxBypass" in value && value.requestSandboxBypass) ||
      ("warning" in value && value.warning)),
  );
}

function approvedUrl(url: string, origins: readonly string[]): boolean {
  const origin = urlOrigin(url);
  return (
    origin !== undefined &&
    (origins.includes(origin) ||
      [
        "https://github.com",
        "https://raw.githubusercontent.com",
        "https://api.github.com",
      ].includes(origin))
  );
}

export function automaticallyApprove(
  request: PermissionRequest,
  prompt: PermissionPrompt,
  origins: readonly string[],
): boolean {
  if (requiresUser(request) || requiresUser(prompt)) return false;
  switch (request.kind) {
    case "read":
      return true;
    case "url":
      return approvedUrl(request.url, origins);
    case "shell":
      // Use the runtime's shell parser, not command-name or text heuristics.
      return (
        request.commands.length > 0 &&
        request.commands.every((command) => command.readOnly === true) &&
        !request.hasWriteFileRedirection &&
        request.possibleUrls.every(({ url }) => approvedUrl(url, origins))
      );
    case "mcp":
      return (
        ["github", "github-mcp", "github-mcp-server"].includes(
          request.serverName,
        ) && request.readOnly === true
      );
    default:
      return false;
  }
}

export function permissionHandler(options: {
  isActive: () => boolean;
  approvedOrigins: () => readonly string[];
  rememberOrigin: (origin: string) => Promise<void>;
  ask: (description: Description) => Promise<boolean>;
}): PermissionHandler {
  return async (request, invocation) => {
    const reject = {
      kind: "reject" as const,
      feedback: "The application is closed, untrusted, or approval was denied.",
    };
    if (!options.isActive()) return reject;
    if (
      automaticallyApprove(
        request,
        invocation.promptRequest,
        options.approvedOrigins(),
      )
    ) {
      return { kind: "approve-once" };
    }
    const origin =
      request.kind === "url" &&
      !requiresUser(request) &&
      !requiresUser(invocation.promptRequest)
        ? urlOrigin(request.url)
        : undefined;
    const description = describePermission(request, invocation.promptRequest);
    const approved = await options.ask({
      ...description,
      ...(origin ? { approvalLabel: `Allow ${origin} and remember` } : {}),
    });
    if (!approved || !options.isActive()) return reject;
    if (origin) await options.rememberOrigin(origin);
    return options.isActive() ? { kind: "approve-once" } : reject;
  };
}
