import React, {useEffect, useState, useRef, createContext} from 'react';
import {
    Auth,
    AuthError,
    AppRemote,
    Player,
    SpotifyURI,
    SpotifyScope,
    SpotifySession,
    PlayerState as SDKPlayerState,
} from '@wwdrew/expo-spotify-sdk';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import * as Linking from 'expo-linking';
import SpotifyWebApi from 'spotify-web-api-node';
import { PlayerState, PlaybackControls } from '../helpers/types';
import { isAudioPlaying, isAudioActivityAvailable } from '../../modules/expo-audio-activity';

const spotifyWebApi = new SpotifyWebApi();

// `AppRemote.authorizeAndPlay` wakes a suspended Spotify (launching it), starts
// playback, then connects — the only reliable way to recover from a
// CONNECTION_FAILED where plain connect() can't revive Spotify. It's added in
// @wwdrew/expo-spotify-sdk above 2.1.0 (see upstream PR); feature-detect so we
// use it once the package ships and fall back to a deep-link wake until then.
type AuthorizeAndPlay = (accessToken: string, uri?: string) => Promise<void>;
const authorizeAndPlay: AuthorizeAndPlay | undefined = (
    AppRemote as unknown as { authorizeAndPlay?: AuthorizeAndPlay }
).authorizeAndPlay;

const SPOTIFY_TOKEN_REFRESH_URL = "https://us-central1-organic-poetry-135723.cloudfunctions.net/endpoint/refresh/";
const SPOTIFY_TOKEN_SWAP_URL = "https://us-central1-organic-poetry-135723.cloudfunctions.net/endpoint/swap/";
const REFRESH_TOKEN_STORAGE_KEY = "@spotify:refreshToken";
const SCOPES: SpotifyScope[] = [
    "app-remote-control",
    "streaming",
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-private",
    "playlist-modify-public",
];

interface AuthOptions {
    showDialog?: boolean;
}

export type ErrorKind = "connection" | "auth" | "generic";

type Props = {
  children: React.ReactNode;
}

interface AppContext {
    authenticate: (options?: AuthOptions) => void;
    remote: PlaybackControls;
    isConnected: boolean;
    remoteConnected: boolean;
    userPressedConnected: boolean;
    setUserPressedConnected: (value: boolean) => void;
    error?: string;
    errorKind?: ErrorKind;
    clearError: () => void;
    reconnect: () => Promise<void>;
    disconnect: () => Promise<void>;
    playerState?: PlayerState;
    api: SpotifyWebApi;
    user: SpotifyApi.UserObjectPrivate;
    // Spotify's App Remote only permits on-demand playback for Premium accounts
    // ("A Spotify Premium account is required to play a single track uri"). Free
    // users authenticate fine but Player.play(uri) silently no-ops. Derived from
    // the profile's `product` field. undefined = not yet known (profile pending).
    isPremium?: boolean;
}

const noopControls: PlaybackControls = {
    playUri: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    skipToNext: async () => undefined,
    skipToPrevious: async () => undefined,
    seek: async () => undefined,
    getPlayerState: async () => undefined,
    queue: async () => undefined,
};

const defaultValue: AppContext = {
    authenticate: () => { },
    remote: noopControls,
    isConnected: false,
    remoteConnected: false,
    userPressedConnected: false,
    setUserPressedConnected: () => {},
    clearError: () => {},
    reconnect: async () => {},
    disconnect: async () => {},
    api: spotifyWebApi,
    user: {} as SpotifyApi.UserObjectPrivate,
}

const mapSDKPlayerState = (s: SDKPlayerState): PlayerState => ({
    isPaused: s.isPaused,
    playbackPosition: s.playbackPosition,
    track: {
        uri: s.track.uri,
        name: s.track.name,
        duration: s.track.duration,
        artist: { name: s.track.artist.name },
    },
});

export const AppContext = createContext(defaultValue);

export const AppContextProvider = (props: Props) => {
    const [isConnected, setIsConnected] = useState(false);
    const [userPressedConnected, setUserPressedConnected] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [errorKind, setErrorKind] = useState<ErrorKind | undefined>();
    const [token, setToken] = useState<string | null>(null);
    const [remoteConnected, setRemoteConnected] = useState(false);
    const [playerState, setPlayerState] = useState<PlayerState>();
    const [user, setUser] = useState<SpotifyApi.UserObjectPrivate>({} as SpotifyApi.UserObjectPrivate);
    const [isPremium, setIsPremium] = useState<boolean | undefined>(undefined);
    const tokenRef = useRef<string | null>(null);
    const userPressedConnectedRef = useRef(false);

    useEffect(() => {
        tokenRef.current = token;
        setIsConnected(!!token);
    }, [token]);

    useEffect(() => {
        userPressedConnectedRef.current = userPressedConnected;
    }, [userPressedConnected]);

    const reportError = (message: string, kind: ErrorKind) => {
        setError(message);
        setErrorKind(kind);
    };

    const clearError = () => {
        setError(undefined);
        setErrorKind(undefined);
    };

    const persistSession = async (session: SpotifySession) => {
        if (session.refreshToken) {
            await AsyncStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, session.refreshToken);
        }
        spotifyWebApi.setAccessToken(session.accessToken);
        setToken(session.accessToken);
        try {
            await AppRemote.connect(session.accessToken);
        } catch (err: any) {
            // Only surface connection errors when the user actively asked to connect.
            // Silent background reconnects (e.g. on app reload while Spotify isn't
            // playing) fail expectedly and must not spam alerts.
            if (userPressedConnectedRef.current) {
                reportError(err?.message ?? "Failed to connect to Spotify app", "connection");
            }
        }
    };

    const authenticate = async (options?: AuthOptions) => {
        clearError();
        try {
            await Auth.cancelPending();
            const session = await Auth.authenticate({
                scopes: SCOPES,
                tokenSwapURL: SPOTIFY_TOKEN_SWAP_URL,
                tokenRefreshURL: SPOTIFY_TOKEN_REFRESH_URL,
                showDialog: options?.showDialog,
            });
            await persistSession(session);
        } catch (err: unknown) {
            if (err instanceof AuthError && err.code === "USER_CANCELLED") {
                return;
            }
            reportError(err instanceof Error ? err.message : String(err), "auth");
        }
    };

    useEffect(() => {
        if (!token) return;
        spotifyWebApi.getMe().then(
            (data) => {
                const profile = data.body as SpotifyApi.UserObjectPrivate;
                setUser(profile);
                // `product` is "premium" | "free" | "open". Only Premium can drive
                // App Remote playback, so a non-premium value is the definitive
                // cause of "pressed play but nothing happens".
                const premium = profile.product === "premium";
                setIsPremium(premium);
                if (!premium) {
                    console.log("Spotify account is not Premium — playback control unavailable", profile.product);
                }
            },
            (err) => reportError(err.message, "generic"),
        );
    }, [token]);

    useEffect(() => {
        (async () => {
            const refreshToken = await AsyncStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
            if (!refreshToken) return;
            try {
                const session = await Auth.refresh({
                    refreshToken,
                    tokenRefreshURL: SPOTIFY_TOKEN_REFRESH_URL,
                    scopes: SCOPES,
                });
                await persistSession(session);
            } catch {
                await AsyncStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
            }
        })();
    }, []);

    useEffect(() => {
        setRemoteConnected(AppRemote.isConnected());
        const stateSub = AppRemote.addListener("connectionStateChange", ({state}) => {
            setRemoteConnected(state === "connected");
        });
        const errSub = AppRemote.addListener("connectionError", ({message}) => {
            // App Remote emits this on every transient drop — the expected
            // ~30s post-pause teardown, and the initial connect() failure that
            // playUri recovers from via authorizeAndPlay. Surfacing a modal here
            // spams "Spotify isn't connected" even while playback is fine. We do
            // NOT alert from this ambient listener; a connection failure that
            // blocks a user action is reported by that action (playUri/reconnect).
            console.log('AppRemote connectionError', message);
        });
        return () => {
            stateSub.remove();
            errSub.remove();
        };
    }, []);

    useEffect(() => {
        if (!remoteConnected) {
            setPlayerState(undefined);
            return;
        }
        let mounted = true;
        Player.getPlayerState().then(
            (s) => { if (mounted) setPlayerState(mapSDKPlayerState(s)); },
            () => {},
        );
        const sub = Player.addListener("playerStateChange", (s) => {
            setPlayerState(mapSDKPlayerState(s));
        });
        return () => {
            mounted = false;
            sub.remove();
        };
    }, [remoteConnected]);

    useEffect(() => {
        return () => {
            AppRemote.disconnect().catch(() => {});
        };
    }, []);

    const ensureRemoteConnected = async () => {
        if (AppRemote.isConnected()) return;
        const accessToken = tokenRef.current;
        if (!accessToken) {
            throw new Error("Not authenticated with Spotify.");
        }
        await AppRemote.connect(accessToken);
    };

    // User-initiated recovery from a CONNECTION_FAILED: wake Spotify and
    // reconnect. Prefers authorizeAndPlay (revives a suspended Spotify in one
    // step); otherwise deep-links to foreground Spotify and lets the AppState
    // listener below complete the reconnect when the user returns.
    const reconnect = async () => {
        const accessToken = tokenRef.current;
        if (!accessToken) return;
        clearError();
        if (authorizeAndPlay) {
            try {
                await authorizeAndPlay(accessToken);
            } catch (err: any) {
                reportError(err?.message ?? "Failed to reconnect to Spotify", "connection");
            }
            return;
        }
        await Linking.openURL("spotify://").catch(() => {});
    };

    // Log out: tear down the App Remote connection and clear the stored
    // session. Dropping the token flips isConnected to false, which surfaces
    // the Authenticate ("Connect to Spotify") screen for a fresh login.
    const disconnect = async () => {
        try { await AppRemote.disconnect(); } catch {}
        await AsyncStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
        setToken(null);
        setUser({} as SpotifyApi.UserObjectPrivate);
        setIsPremium(undefined);
        clearError();
    };

    // Silent reconnect when Tempofy returns to the foreground. Common flow:
    // user opens Spotify, starts playing, switches back here — connect() then
    // succeeds against a now-running Spotify. No playback started, no alert on
    // failure (the user can still trigger reconnect() explicitly).
    useEffect(() => {
        const sub = AppState.addEventListener("change", (state) => {
            if (state !== "active") return;
            const accessToken = tokenRef.current;
            if (!accessToken || AppRemote.isConnected()) return;
            AppRemote.connect(accessToken).catch(() => {});
        });
        return () => sub.remove();
    }, []);

    // Playback-gated auto-reconnect (native flag, no Web API). While
    // authenticated, foreground, and disconnected, poll isAudioPlaying() — a
    // free, synchronous native read (AVAudioSession.isOtherAudioPlaying /
    // AudioManager.isMusicActive) — every 2s. While paused this is silent and
    // costs nothing (no network, no Web API spam). When audio is playing (e.g.
    // the user resumed via a Bluetooth remote, which Tempofy never sees
    // otherwise) we run the wake path (authorizeAndPlay, same as the Settings
    // button) to reattach.
    //
    // Gating on playback means a deliberate pause is never auto-resumed. The
    // 2-consecutive-read debounce avoids triggering on the brief silent gap
    // between tracks. The native flag is not Spotify-specific (any audio reads
    // true), which is acceptable here since Tempofy users only play Spotify.
    //
    // No-op until the native module ships in a dev build: isAudioActivityAvailable
    // is false on older binaries, so the effect returns immediately and nothing
    // polls or reconnects automatically (the manual reconnect button still works).
    useEffect(() => {
        if (!token || remoteConnected || !isAudioActivityAvailable) return;
        let attempting = false;
        let playingStreak = 0;
        const POLL_INTERVAL_MS = 2000;
        const REQUIRED_STREAK = 2;
        const tick = async () => {
            if (attempting) return;
            const accessToken = tokenRef.current;
            if (!accessToken || AppState.currentState !== "active" || AppRemote.isConnected()) {
                return;
            }
            playingStreak = isAudioPlaying() ? playingStreak + 1 : 0;
            if (playingStreak < REQUIRED_STREAK) return;
            attempting = true;
            try {
                const wake = authorizeAndPlay
                    ? authorizeAndPlay(accessToken)
                    : Linking.openURL("spotify://");
                await Promise.resolve(wake);
            } catch {
                // Wake failed — try again on a later tick.
            } finally {
                attempting = false;
                playingStreak = 0;
            }
        };
        const interval = setInterval(tick, POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [token, remoteConnected]);

    const isConnectionError = (err: any) => {
        if (
            err?.code === "CONNECTION_FAILED" ||
            err?.code === "CONNECTION_LOST" ||
            err?.code === "NOT_CONNECTED"
        ) {
            return true;
        }
        // The native connection-refused failure currently reaches JS with code
        // "UNKNOWN" (expo doesn't surface the AppRemoteException code), so fall
        // back to matching its message signature.
        const msg = String(err?.message ?? "").toLowerCase();
        return (
            msg.includes("connection refused") ||
            msg.includes("connection attempt failed") ||
            msg.includes("stream error") ||
            msg.includes("not connected")
        );
    };

    const remote: PlaybackControls = {
        playUri: async (uri) => {
            try {
                await ensureRemoteConnected();
                await Player.play(SpotifyURI.from(uri));
            } catch (err: any) {
                // Spotify was suspended (CONNECTION_FAILED / Connection refused).
                // If the SDK supports it, wake Spotify and play the track in one
                // step instead of bubbling up an unrecoverable connection error.
                const accessToken = tokenRef.current;
                if (authorizeAndPlay && accessToken && isConnectionError(err)) {
                    await authorizeAndPlay(accessToken, uri);
                    return;
                }
                throw err;
            }
        },
        pause: async () => {
            try {
                await ensureRemoteConnected();
                await Player.pause();
            } catch (err: any) {
                // Pause is idempotent: its goal is "not playing". The App Remote
                // rejects Player.pause() with "The request failed." when there's
                // nothing to pause (the mirror of resume rejecting when nothing
                // is paused), and a suspended/disconnected Spotify (a long
                // autoSkipTime window can outlast the connection, like the rest
                // gap does) also isn't playing. Both already satisfy the intent,
                // so resolve instead of surfacing an error. We deliberately do
                // NOT wake via authorizeAndPlay here — that would START playback,
                // the opposite of pausing. A genuine still-playing failure would
                // have to reach us as some other signature; treat these two as
                // the no-op they are.
                const msg = String(err?.message ?? "").toLowerCase();
                if (isConnectionError(err) || msg.includes("the request failed")) {
                    return;
                }
                throw err;
            }
        },
        resume: async () => {
            try {
                await ensureRemoteConnected();
                await Player.resume();
            } catch (err: any) {
                // Spotify was suspended while paused — a long Pause-mode rest
                // gap can outlast the App Remote connection, and plain
                // connect() can't revive a suspended Spotify (CONNECTION_FAILED).
                // Wake it and resume in one step; authorizeAndPlay with no uri
                // resumes the current track (see SDK README).
                const accessToken = tokenRef.current;
                if (authorizeAndPlay && accessToken && isConnectionError(err)) {
                    await authorizeAndPlay(accessToken);
                    return;
                }
                throw err;
            }
        },
        skipToNext: async () => {
            await ensureRemoteConnected();
            await Player.skipNext();
        },
        skipToPrevious: async () => {
            await ensureRemoteConnected();
            await Player.skipPrevious();
        },
        seek: async (positionMs) => {
            await ensureRemoteConnected();
            await Player.seekTo(positionMs);
        },
        queue: async (uri) => {
            await ensureRemoteConnected();
            await Player.queue(SpotifyURI.from(uri));
        },
        getPlayerState: async () => {
            try {
                await ensureRemoteConnected();
                const s = await Player.getPlayerState();
                return mapSDKPlayerState(s);
            } catch {
                return undefined;
            }
        },
    };

    return (
        <AppContext.Provider
            value={{
                authenticate,
                remote,
                isConnected,
                remoteConnected,
                userPressedConnected,
                setUserPressedConnected,
                playerState,
                error,
                errorKind,
                clearError,
                reconnect,
                disconnect,
                api: spotifyWebApi,
                user,
                isPremium
            }}
        >
            {props.children}
        </AppContext.Provider>

    );
};
