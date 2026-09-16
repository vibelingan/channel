export interface InspectedToolSurface {
  known: boolean;
  enabled: boolean;
  detail: string;
}

export function inspectWorkspaceToolSurface(body: unknown): InspectedToolSurface;
