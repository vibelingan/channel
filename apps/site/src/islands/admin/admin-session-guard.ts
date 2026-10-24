import { getToken, getUser } from '../../lib/session.ts';

type Owner = { token: string; actorId: string };
interface AdminSessionGuard {
  pause(): void;
  capture(): string;
  generation(): number;
  resume(next: Owner): void;
  expired(token: string): void;
  release(): void;
}
let active: AdminSessionGuard | undefined;
type RequestTicket = {
  guard: AdminSessionGuard | undefined;
  token: string;
  generation: number | undefined;
};
const errorSessions = new WeakMap<Error, RequestTicket>();
export function bindAdminErrorSession<T extends Error>(error: T, ticket: RequestTicket): T {
  errorSessions.set(error, ticket);
  return error;
}
export function isCurrentAdminError(error: Error) {
  const ticket = errorSessions.get(error);
  return (
    ticket === undefined ||
    (ticket.token === getToken() &&
      (!ticket.guard ||
        (ticket.guard === active && ticket.guard.generation() === ticket.generation)))
  );
}
export class AdminSessionPausedError extends Error {
  constructor() {
    super('Reconnect the original account before continuing. Your open forms have been kept.');
  }
}

/** Only the verified dashboard installs this guard. Other site islands keep their own auth flow. */
export function installAdminSessionGuard(initial: Owner, onPause: () => void): AdminSessionGuard {
  const originalActor = initial.actorId;
  let owner = { ...initial };
  let paused = false;
  let generation = 0;
  const guard: AdminSessionGuard = {
    pause() {
      if (active !== guard || paused) return;
      paused = true;
      onPause();
    },
    capture() {
      if (paused || getToken() !== owner.token || getUser()?.id !== owner.actorId) {
        guard.pause();
        throw new AdminSessionPausedError();
      }
      return owner.token;
    },
    generation: () => generation,
    resume(next: Owner) {
      if (
        active !== guard ||
        next.actorId !== originalActor ||
        !next.token ||
        getToken() !== next.token ||
        getUser()?.id !== next.actorId
      )
        throw new AdminSessionPausedError();
      owner = { ...next };
      generation++;
      paused = false;
    },
    expired(token: string) {
      if (token === owner.token && token === getToken()) guard.pause();
    },
    release() {
      if (active === guard) active = undefined;
    },
  };
  active = guard;
  return guard;
}

export function captureAdminRequestSession(action: string) {
  const guard = action === 'me' ? undefined : active;
  return { guard, token: guard ? guard.capture() : getToken(), generation: guard?.generation() };
}
export function confirmAdminRequestSession(ticket: ReturnType<typeof captureAdminRequestSession>) {
  if (!ticket.guard) return;
  if (
    active !== ticket.guard ||
    ticket.guard.generation() !== ticket.generation ||
    ticket.guard.capture() !== ticket.token
  )
    throw new AdminSessionPausedError();
}
export function reportExpiredAdminSession(ticket: ReturnType<typeof captureAdminRequestSession>) {
  if (ticket.guard === active && ticket.guard?.generation() === ticket.generation)
    ticket.guard?.expired(ticket.token);
}
