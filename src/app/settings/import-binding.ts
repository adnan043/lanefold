/** A dry run is only valid for the workspace it was run for. */
export function dryRunMatches(loaded: {workspaceId: number | string} | null, currentId: number | string | undefined): boolean {
  return !!loaded && currentId !== undefined && String(loaded.workspaceId) === String(currentId);
}
