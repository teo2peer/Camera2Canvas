import RAPIER from "@dimforge/rapier3d-compat";

let ready: Promise<void> | null = null;

export async function initRapier(): Promise<typeof RAPIER> {
  if (!ready) ready = RAPIER.init();
  await ready;
  return RAPIER;
}
