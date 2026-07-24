import React, {useState, createContext, useEffect, useContext, useRef} from 'react';
import { SettingsContext } from '../context/SettingsContext';
import { useInterval } from '../helpers/hooks';
import { AutoSkipMode, TrackObject } from '../helpers/types';
import { QueueContext } from './QueueContext';
import { AppContext } from './SpotifyContext';

type Props = {
  children: React.ReactNode;
}

// How long the transition guard may stay set without the device confirming the
// target track. Confirmation normally lands within ~1s, well before this, so in
// normal operation the guard is cleared by confirmation; this only fires when
// the confirmation never arrives, so the guard self-heals instead of disabling
// auto-advance forever.
const TRANSITION_GUARD_TIMEOUT = 6000;

// Spotify can't navigate to a previous track for bare-URI playback — its
// previous button just restarts the current track. That restart is a backward
// position jump on the same track, which we never do ourselves (our only seek is
// forward to the intro), so a jump back of at least this many ms means the
// remote's previous button was pressed → go back through our own history.
const REMOTE_PREVIOUS_JUMP = 3000;

interface NowPlayingContext {
    skipToNext: () => void;
    skipToPrevious: () => void;
    userSelectedTrack: (track: TrackObject) => void;
    timeLeft: number | null;
    // True during the Pause-mode rest gap, while playback is paused but about to
    // auto-resume. The now-playing button reads this to show as playing so the
    // user can keep it paused for real.
    isAutoPausing: boolean;
    // Wall-clock time (ms) the current rest gap is scheduled to end, or null when
    // not pausing. The pause progress bar reads this so it can show the true
    // remaining fraction even when mounted partway through the gap (e.g. opening
    // fullscreen mid-pause), instead of restarting from full.
    pauseEndsAt: number | null;
    // Wall-clock time (ms) the active playback countdown fires (pauses/skips), or
    // null whenever it isn't ticking (paused, off, or not started). The progress
    // bar reads this the same way it reads pauseEndsAt, so it can drain over the
    // play phase too and pick up the true remaining fraction when mounted midway.
    countdownEndsAt: number | null;
    // The full duration (ms) the current countdown started from — autoSkipTime, or
    // a shorter value when capped against the track's outro. Paired with
    // countdownEndsAt to compute the played fraction.
    countdownTotal: number | null;
    // Cancel the scheduled auto-resume and keep playback in its current state.
    cancelAutoResume: () => void;
}

const defaultValue: NowPlayingContext = {
    skipToNext: () => undefined,
    skipToPrevious: () => undefined,
    userSelectedTrack: () => undefined,
    timeLeft: null,
    isAutoPausing: false,
    pauseEndsAt: null,
    countdownEndsAt: null,
    countdownTotal: null,
    cancelAutoResume: () => undefined
}

export const NowPlayingContext = createContext(defaultValue);

export const NowPlayingContextProvider = (props: Props) => {
    const { playerState, remote } = useContext(AppContext);
    const { consumeNextInQueue, goPrevious, peekNext, peekPrevious, canSkipNext, currentTrack, setCurrentTrack } = useContext(QueueContext);
    const { introSkipTime, outroSkipTime, autoSkipMode, autoSkipTime, pauseTime } = useContext(SettingsContext);
    const [timeLeft, setTimeLeft] = useState<number | null>(autoSkipTime);
    const [waiting, setWaiting] = useState(false);
    // Only whole seconds are ever displayed, so a 1s tick is enough. A faster
    // interval re-renders every NowPlayingContext consumer 10×/sec for no
    // visible change, which keeps the CPU (and device) hot during playback.
    const timerInterval = 1000;
    const [updateInterval, setUpdateInterval] = useState<number | null>(null);
    const endTimeRef = useRef<number | null>(null);
    // State mirror of endTimeRef, exposed for the progress bar. The ref stays the
    // source of truth for the synchronous reads in the playerState effect; this
    // setter writes both so a re-render is triggered whenever the countdown's end
    // time changes (starts, pauses to null, resumes).
    const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null);
    const setEndTime = (value: number | null) => {
        endTimeRef.current = value;
        setCountdownEndsAt(value);
    };
    // The duration the current countdown started from, for the played fraction.
    const [countdownTotal, setCountdownTotal] = useState<number | null>(null);
    const pausedRemainingRef = useRef<number | null>(null);
    // Mirrors playerState.isPaused so async callbacks (e.g. resetCountDown at
    // the tail of a pause/skip) can read the *current* pause state instead of
    // the value captured when they started.
    const isPausedRef = useRef(false);
    // True while we're deliberately switching tracks (manual skip / userSelected).
    // The App Remote fires transient and trailing (old-track) playerStateChange
    // events during a switch; without this guard the auto-advance below misreads
    // them as "track ended" and fires an extra, unwanted skip. The guard is held
    // until the device *confirms* our target track is playing (see the effect),
    // not just until playUri() resolves — Spotify emits those events after the
    // promise settles, so clearing it early lets a trailing old-track event slip
    // through and skip an extra track or two.
    const isTransitioningRef = useRef(false);
    // The uri we last asked the device to play. The transition guard clears only
    // once a playerState event reports this uri, so stale events for the track we
    // just left can't trigger a spurious auto-advance.
    const targetUriRef = useRef<string | null>(null);
    // When the current transition started. Confirmation normally fires within a
    // second; this is a fallback so a switch whose target uri is never echoed
    // back (silent play failure, uri mismatch, dropped event) can't leave the
    // guard stuck true and disable auto-advance forever.
    const transitionStartRef = useRef<number>(0);
    // True when the current countdown was shortened to stop at the track's outro
    // buffer rather than running a full autoSkipTime. When such a countdown
    // fires we've reached the dead tail of the track, so we advance to the next
    // track regardless of mode instead of pausing into it.
    const countdownCappedRef = useRef(false);
    // The rest gap (Skip and Pause modes both pause for pauseTime before the
    // next part starts). During it the now-playing button shows as playing so
    // the instructor can keep it paused. A ref mirror lets the playerState
    // effect read it without a stale closure.
    const [isAutoPausing, setIsAutoPausing] = useState(false);
    const isAutoPausingRef = useRef(false);
    // When the current rest gap ends (Date.now() + pauseTime), exposed so the
    // pause progress bar can render the true remaining fraction; null off-gap.
    const [pauseEndsAt, setPauseEndsAt] = useState<number | null>(null);
    // Set when the instructor takes control during the gap (a play press on a
    // remote, or a tap on the button) — the gap ends and the scheduled resume
    // is skipped so playback stays paused.
    const autoResumeCancelledRef = useRef(false);
    const pauseHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pauseHoldResolveRef = useRef<(() => void) | null>(null);
    // The uri we last seeded into Spotify's native queue, to avoid re-queueing
    // the same track repeatedly.
    const seededNextUriRef = useRef<string | null>(null);
    // Last observed playback position and its track uri, to spot the backward
    // jump a remote skip-previous produces (see REMOTE_PREVIOUS_JUMP). The uri is
    // tracked alongside so the jump is only measured between consecutive events
    // on the SAME track — comparing across a track change would misread the new
    // track's lower position as a backward jump.
    const lastPositionRef = useRef<number>(0);
    const lastPositionUriRef = useRef<string | null>(null);

    useEffect(() => {
        if(!playerState) {
            return;
        }
        const wasPaused = isPausedRef.current;
        isPausedRef.current = playerState.isPaused;
        // Measure a backward position jump only between consecutive events on the
        // same track, then record this event's position/uri. Updated up-front for
        // every event so a track change can't leave a stale position behind.
        const sameTrackAsLast = lastPositionUriRef.current === playerState.track.uri;
        const jumpedBack = sameTrackAsLast && playerState.playbackPosition < lastPositionRef.current - REMOTE_PREVIOUS_JUMP;
        lastPositionRef.current = playerState.playbackPosition;
        lastPositionUriRef.current = playerState.track.uri;
        if(isAutoPausingRef.current && wasPaused && !playerState.isPaused) {
            if(currentTrack && playerState.track.uri === currentTrack.uri) {
                // Same track resumed during the rest gap = a play press (remote,
                // headset, or button). The instructor is taking control, so block
                // the play (cancelAutoResume re-pauses) and cancel the scheduled
                // auto-resume. A second play press, gap now over, resumes.
                cancelAutoResume();
                return;
            }
            // A different track started during the gap = a skip press. End the
            // gap without re-pausing and fall through to follow the skip below.
            endAutoPauseForSkip();
        }
        if(playerState.isPaused) {
            if(endTimeRef.current !== null) {
                pausedRemainingRef.current = Math.max(0, endTimeRef.current - Date.now());
                setEndTime(null);
            }
            setUpdateInterval(null);
        } else {
            if(pausedRemainingRef.current !== null) {
                setEndTime(Date.now() + pausedRemainingRef.current);
                pausedRemainingRef.current = null;
            }
            setUpdateInterval(timerInterval);
        }
        if(isTransitioningRef.current) {
            // Mid-switch. Clear the guard once the device confirms our target
            // track is the one now playing; trailing events for the previous
            // track (uri != target) are ignored until then, so they can't be
            // misread as a natural track change and skip ahead. The elapsed-time
            // fallback recovers if the target uri is never echoed back, so the
            // guard can't stay stuck and disable auto-advance permanently.
            const confirmed = targetUriRef.current && playerState.track.uri === targetUriRef.current;
            const timedOut = transitionStartRef.current > 0 && Date.now() - transitionStartRef.current > TRANSITION_GUARD_TIMEOUT;
            if(confirmed || timedOut) {
                isTransitioningRef.current = false;
            }
        } else if(currentTrack && currentTrack.uri != playerState.track.uri) {
            // A track change we didn't initiate: a remote/headset skip-next.
            followExternalChange(playerState.track.uri);
        } else if(currentTrack && jumpedBack && !isAutoPausingRef.current) {
            // Same track, position jumped backward — Spotify restarting it for a
            // remote skip-previous. Go back through our own history instead,
            // since Spotify can't navigate previous here.
            skipToPrevious();
        }
    },[playerState]);

    useInterval(() => {
        if(endTimeRef.current === null) return;
        const remaining = endTimeRef.current - Date.now();
        if(remaining <= 1000) {
            setEndTime(null);
            setTimeLeft(null);
        } else {
            setTimeLeft(remaining);
        }
    }, updateInterval);

    useEffect(() => {
        if(timeLeft === null) {
            onCountDownFinished();
        }
    }, [timeLeft]);

    // Seed Spotify's own queue with the upcoming track so a media remote's
    // skip-next has a real target — bare-URI playback otherwise leaves Spotify
    // with nothing to skip to. Only in Skip/Pause modes: seeding also makes a
    // track auto-advance at its natural end, which would break Off mode's
    // "play one track and stop". When the remote skips, Spotify advances to the
    // seeded track and the playerState effect follows it (followExternalChange).
    useEffect(() => {
        if(autoSkipMode === AutoSkipMode.Off || !currentTrack) {
            seededNextUriRef.current = null;
            return;
        }
        const next = peekNext();
        if(next && next.uri !== seededNextUriRef.current) {
            seededNextUriRef.current = next.uri;
            remote.queue(next.uri).catch(err => console.error('queue next failed', err));
        }
    }, [currentTrack, autoSkipMode]);

    const resetCountDown = (positionMs: number = 0, durationMs?: number) => {
        console.log('resetCountDown');
        let total = autoSkipTime;
        // Never let the countdown run into the track's final outroSkipTime: skip
        // before the song's tail so the listener only ever hears playing song,
        // not the fade-out/silence at the end. When the cap wins, flag it so the
        // firing advances the track instead of pausing into the outro.
        countdownCappedRef.current = false;
        if(durationMs && durationMs > 0) {
            const untilOutro = Math.max(durationMs - outroSkipTime - positionMs, 0);
            if(untilOutro < total) {
                total = untilOutro;
                countdownCappedRef.current = true;
            }
        }
        setCountdownTotal(total);
        if(isPausedRef.current) {
            // Playback is paused (manually, or by Pause mode). Don't start
            // ticking against wall-clock time — park the fresh countdown in the
            // paused-remaining slot so the resume handler launches it only once
            // playback actually resumes. Otherwise the timer would count down
            // while the music is stopped.
            pausedRemainingRef.current = total;
            setEndTime(null);
            setTimeLeft(total);
            setUpdateInterval(null);
            return;
        }
        setEndTime(Date.now() + total);
        pausedRemainingRef.current = null;
        setTimeLeft(total);
        setUpdateInterval(timerInterval);
    }

    // Enter the rest gap: flag it (so the button shows as playing and a play
    // press is treated as "take control"), then wait pauseTime. The wait can be
    // ended early by cancelAutoResume so the instructor isn't kept waiting.
    const holdPauseGap = async () => {
        autoResumeCancelledRef.current = false;
        isAutoPausingRef.current = true;
        setIsAutoPausing(true);
        setPauseEndsAt(Date.now() + pauseTime);
        await new Promise<void>(resolve => {
            pauseHoldResolveRef.current = resolve;
            pauseHoldTimerRef.current = setTimeout(resolve, pauseTime);
        });
        if(pauseHoldTimerRef.current) {
            clearTimeout(pauseHoldTimerRef.current);
            pauseHoldTimerRef.current = null;
        }
        pauseHoldResolveRef.current = null;
        isAutoPausingRef.current = false;
        setIsAutoPausing(false);
        setPauseEndsAt(null);
    };

    // Instructor took control during the rest gap. Block any play that slipped
    // in (so the next part doesn't start), end the gap, and flag the cancel so
    // the surrounding flow skips its scheduled resume — leaving playback paused
    // until they press play again.
    const cancelAutoResume = () => {
        if(!isAutoPausingRef.current) {
            return;
        }
        autoResumeCancelledRef.current = true;
        isAutoPausingRef.current = false;
        setIsAutoPausing(false);
        if(pauseHoldResolveRef.current) {
            pauseHoldResolveRef.current();
        }
        // We always end up paused. Re-pause only if playback actually slipped
        // into playing (a remote/headset play press); an in-app tap acts on the
        // already-paused track, so there's nothing to undo.
        const slippedIntoPlaying = !isPausedRef.current;
        isPausedRef.current = true;
        if(slippedIntoPlaying) {
            remote.pause().catch(err => console.error('cancelAutoResume pause failed', err));
        }
    };

    // Cancel a countdown or rest gap still pending from the track we're leaving.
    // A user-initiated play (track pick, shuffle, previous) starts fresh, so a
    // leftover countdown must not fire mid-switch and pause or skip the track we
    // just started — the "plays ~1s then stops" after re-shuffling while another
    // track (with a live countdown) is still playing. Stops the timer and
    // releases any in-progress rest gap without resuming. We must NOT setTimeLeft
    // (null would trip onCountDownFinished); the caller's resetCountDown arms a
    // fresh positive countdown right after.
    const cancelPendingAutoAdvance = () => {
        setEndTime(null);
        pausedRemainingRef.current = null;
        setUpdateInterval(null);
        if(isAutoPausingRef.current || pauseHoldResolveRef.current) {
            autoResumeCancelledRef.current = true;
            isAutoPausingRef.current = false;
            setIsAutoPausing(false);
            setPauseEndsAt(null);
            if(pauseHoldTimerRef.current) {
                clearTimeout(pauseHoldTimerRef.current);
                pauseHoldTimerRef.current = null;
            }
            if(pauseHoldResolveRef.current) {
                pauseHoldResolveRef.current();
                pauseHoldResolveRef.current = null;
            }
        }
    };

    // A skip (not a play) happened during the rest gap: end the gap and cancel
    // the scheduled resume, but DON'T re-pause — we want the skipped-to track to
    // play. The follow logic then syncs to whatever track Spotify landed on.
    const endAutoPauseForSkip = () => {
        autoResumeCancelledRef.current = true;
        isAutoPausingRef.current = false;
        setIsAutoPausing(false);
        if(pauseHoldResolveRef.current) {
            pauseHoldResolveRef.current();
        }
    };

    // Spotify changed track on its own (remote/headset skip, or a natural
    // end advancing into the seeded track). Sync our queue/history to match and
    // land on the track the same way an app skip would, without re-playing it
    // (Spotify is already playing it).
    const followExternalChange = (observedUri: string) => {
        const next = peekNext();
        const prev = peekPrevious();
        if(next && observedUri === next.uri) {
            const advanced = consumeNextInQueue();
            if(advanced) {
                setCurrentTrack(advanced);
                landOnExternalTrack(advanced);
                return;
            }
        }
        if(prev && observedUri === prev.uri) {
            const back = goPrevious();
            if(back) {
                setCurrentTrack(back);
                landOnExternalTrack(back);
                return;
            }
        }
        // Unknown change (user played something unrelated in Spotify, or a stale
        // event) — take over by playing our own next track.
        playNextInQueue();
    };

    // Apply our start behaviour to a track Spotify already moved to: jump to the
    // intro-skip offset and (re)start the countdown. The transition guard is held
    // so the seek's own events don't get misread as another change.
    const landOnExternalTrack = async (item: TrackObject) => {
        isTransitioningRef.current = true;
        transitionStartRef.current = Date.now();
        targetUriRef.current = item.uri;
        try {
            await remote.seek(introSkipTime);
        } catch (err) {
            console.error('follow seek failed', err);
        }
        resetCountDown(introSkipTime, item.duration_ms);
    };

    const onCountDownFinished = () => {
        console.log('onCountDownFinished');
        console.log('waiting',waiting);
        setUpdateInterval(null);
        if(autoSkipMode == AutoSkipMode.Off) {
            // No auto-advance — let the track (outro included) play to its end.
            // Re-arm the counter so it keeps cycling as a plain interval timer
            // instead of stopping at zero after the first countdown. No cap here:
            // we never skip in Off mode, so the counter runs a full autoSkipTime
            // every cycle rather than shortening toward the outro.
            resetCountDown();
            return;
        }
        if(countdownCappedRef.current) {
            // Reached the outro buffer: the playable part is over, so move on
            // rather than pausing into the tail. Applies to Pause mode too.
            skipToNext(true);
        } else if(autoSkipMode == AutoSkipMode.Skip) {
            skipToNext(true);
        } else {
            pausePlayback();
        }
    }

    const userSelectedTrack = async (item: TrackObject) => {
        console.log('userSelectedTrack');
        await playTrack(item);
    }

    const playNextInQueue = async () => {
        console.log('playNextInQueue');
        const nextItem = consumeNextInQueue();
        if(nextItem) {
            playTrack(nextItem);
        }
    }

    const playTrack = async (item: TrackObject) => {
        console.log('playTrack',item.name);
        // Kill any countdown/rest gap left over from the track we're leaving so
        // it can't fire during the switch and pause or skip this fresh track.
        cancelPendingAutoAdvance();
        isTransitioningRef.current = true;
        transitionStartRef.current = Date.now();
        targetUriRef.current = item.uri;
        setWaiting(true);
        setCurrentTrack(undefined);
        try {
            await remote.playUri(item.uri);
            setCurrentTrack(item);
            // Manual play starts at 0 (no intro seek); cap the countdown against
            // this track's length so a short track still skips before its outro.
            resetCountDown(0, item.duration_ms);
            // Leave isTransitioningRef set; the playerState effect clears it once
            // the device confirms this track is playing. Clearing it here (before
            // Spotify emits its events) lets trailing old-track events trigger a
            // spurious auto-advance.
        } catch (err) {
            // Playback couldn't start (e.g. Spotify unreachable). Surface it for
            // logs rather than crashing with an uncaught rejection; the UI drops
            // out of the waiting state below so the user can retry.
            console.log('playTrack failed', err);
            isTransitioningRef.current = false;
        } finally {
            setWaiting(false);
        }
    }

    const skipToNext = async (pauseBeforeStart?: boolean) => {
        console.log('skipToNext');

        const nextItem = consumeNextInQueue();
        if(!nextItem) {
            // Queue is exhausted. There's no next track to play, and Spotify's
            // native skipNext() can't help here because we play tracks by bare
            // URI (no playlist/album context), so it just fails. Stop the
            // auto-skip instead of looping on a doomed skip every cycle, and
            // pause playback so the last track doesn't keep playing on.
            console.log('queue empty, stopping playback');
            setUpdateInterval(null);
            setEndTime(null);
            pausedRemainingRef.current = null;
            setWaiting(false);
            try {
                await remote.pause();
            } catch (err) {
                console.error('pause on empty queue failed', err);
            }
            return;
        }

        isTransitioningRef.current = true;
        transitionStartRef.current = Date.now();
        targetUriRef.current = nextItem.uri;
        // Fresh skip: clear any stale cancel flag from a previous rest gap so a
        // manual skip (which has no gap) still resumes.
        autoResumeCancelledRef.current = false;
        setWaiting(true);

        try {
            // Auto-skip (pauseBeforeStart) holds a silent rest gap (pauseTime)
            // before the next track so the instructor can talk and keep control;
            // a manual skip starts immediately. Pause the CURRENT track and hold
            // the gap BEFORE cueing the next track: playUri always starts playback
            // from 0 (the SDK has no cue/play-from-offset and no volume control),
            // so starting the next track first and only then pausing leaks its
            // first moments as an audible blip at the very start of what should be
            // a silent gap. Cueing the next track only once the gap is over folds
            // its unavoidable 0→intro start-up into the music resuming, so there's
            // no "next-track sound, then silence".
            if(pauseBeforeStart) {
                try {
                    await remote.pause();
                } catch (err) {
                    // A failed pause must not abort the whole skip — fall through
                    // to the gap and cue the next track anyway.
                    console.error('skip pre-pause failed', err);
                }
                await holdPauseGap();
            }
            setCurrentTrack(undefined);
            // The SDK can only play a track from 0 (no play-from-offset), so
            // play → seek would briefly play the intro before jumping. Instead,
            // start the track, pause it immediately, and seek to the intro offset
            // while it's silent — the listener never hears the 0→intro region.
            await remote.playUri(nextItem.uri);
            await remote.pause();
            // The device rejects a seek issued immediately after play, so let it
            // settle first. This wait now happens while paused (silent), so it
            // doesn't reintroduce the audible intro it's here to avoid.
            await new Promise(resolve => setTimeout(resolve, 50));
            await remote.seek(introSkipTime);
            setCurrentTrack(nextItem);
            // Start the next part only if the instructor didn't take control
            // during the gap and playback is still paused. If they pressed play
            // (cancelAutoResume re-paused it) the next track stays cued, paused,
            // until they press play again.
            const response = await remote.getPlayerState().catch(() => undefined);
            if(!autoResumeCancelledRef.current && (!response || response.isPaused)) {
                await remote.resume();
            }
            // Leave isTransitioningRef set; the playerState effect clears it once
            // the device confirms this track is playing, so trailing old-track
            // events during the switch don't trigger a spurious auto-advance.
        } catch (err) {
            console.error('skip failed', err);
            isTransitioningRef.current = false;
        }

        // Playback starts at introSkipTime, so cap the countdown against the
        // remaining song after the intro and before the outro buffer.
        resetCountDown(introSkipTime, nextItem.duration_ms);
        setWaiting(false);
    }

    // App-driven previous (the in-app button). Goes back through our own history
    // rather than relying on Spotify's skip-previous, which restarts the current
    // track when more than a few seconds in. Same blip-free start as a skip.
    const skipToPrevious = async () => {
        console.log('skipToPrevious');
        const prevItem = goPrevious();
        if(!prevItem) {
            return;
        }
        // Kill any leftover countdown/rest gap so it can't pause or skip the
        // track we're about to start (see cancelPendingAutoAdvance).
        cancelPendingAutoAdvance();
        isTransitioningRef.current = true;
        transitionStartRef.current = Date.now();
        targetUriRef.current = prevItem.uri;
        autoResumeCancelledRef.current = false;
        setWaiting(true);
        try {
            setCurrentTrack(prevItem);
            await remote.playUri(prevItem.uri);
            await remote.pause();
            await new Promise(resolve => setTimeout(resolve, 50));
            await remote.seek(introSkipTime);
            // Resume only if still paused — the App Remote rejects resume() with
            // "The request failed." when nothing is paused (e.g. the pause above
            // didn't take because play had only just started).
            const response = await remote.getPlayerState().catch(() => undefined);
            if(!response || response.isPaused) {
                await remote.resume();
            }
        } catch (err) {
            console.error('previous failed', err);
            isTransitioningRef.current = false;
        }
        resetCountDown(introSkipTime, prevItem.duration_ms);
        setWaiting(false);
    }

    const pausePlayback = async () => {
        // Pause mode: when the countdown ends, pause playback, hold the rest gap
        // (pauseTime), then resume automatically.
        setWaiting(true);
        try {
            await remote.pause();
        } catch (err) {
            console.error('pause failed', err);
        }
        await holdPauseGap();
        // Re-read live state. Resume only if the instructor didn't take control
        // during the gap (a play press is treated as "keep it paused", handled
        // by cancelAutoResume) and playback is still paused.
        let response;
        try {
            response = await remote.getPlayerState();
        } catch (err) {
            console.error('pausePlayback getPlayerState failed', err);
        }
        const paused = response ? response.isPaused : isPausedRef.current;
        if(!autoResumeCancelledRef.current && paused) {
            try {
                await remote.resume();
            } catch (err) {
                console.error('resume failed', err);
            }
        }
        // Re-arm the countdown so the pause repeats every autoSkipTime of
        // playback. Cap it against where we are in the track so that, as the
        // song plays out across pause cycles, the countdown shortens and the
        // final firing advances to the next track instead of pausing into the
        // outro (see onCountDownFinished / countdownCappedRef).
        resetCountDown(response ? response.playbackPosition : 0, response ? response.track.duration : undefined);
        setWaiting(false);
    }

    return (
        <NowPlayingContext.Provider
            value={{
                skipToNext,
                skipToPrevious,
                userSelectedTrack,
                timeLeft,
                isAutoPausing,
                pauseEndsAt,
                countdownEndsAt,
                countdownTotal,
                cancelAutoResume
            }}
        >
            {props.children}
        </NowPlayingContext.Provider>
    );
};