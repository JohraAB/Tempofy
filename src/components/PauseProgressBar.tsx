import React, { useContext, useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, ViewStyle } from "react-native";
import { NowPlayingContext } from "../context/NowPlayingContext";
import { SettingsContext } from "../context/SettingsContext";

// A single bar that drains across both phases of a cycle:
//  - while playing, over the countdown to the next skip/pause (countdownEndsAt)
//  - during the Pause-mode rest gap, over the pause itself (pauseEndsAt)
// Both phases expose a wall-clock end time and a total, so the same timing
// animation tracks either one and picks up the true remaining fraction when
// mounted partway through (e.g. opening fullscreen mid-cycle). The fill colour
// switches on the phase so playing and pausing read differently at a glance.
export const PauseProgressBar: React.FC<{
    height?: number;
    playColor?: string;
    pauseColor?: string;
    trackColor?: string;
    style?: ViewStyle;
}> = ({
    height = 6,
    playColor = '#4f6cdd',
    pauseColor = '#e8a13a',
    trackColor = 'rgba(255,255,255,0.15)',
    style,
}) => {
    const { isAutoPausing, pauseEndsAt, countdownEndsAt, countdownTotal } = useContext(NowPlayingContext);
    const { pauseTime } = useContext(SettingsContext);
    const progress = useRef(new Animated.Value(0)).current;

    // Pause takes precedence over the play countdown (the countdown is parked
    // while paused anyway). Each phase supplies its own end time and total.
    const pausing = isAutoPausing;
    const endsAt = pausing ? pauseEndsAt : countdownEndsAt;
    const total = pausing ? pauseTime : countdownTotal;
    const active = endsAt != null && total != null && total > 0;

    useEffect(() => {
        if(active) {
            // Start from how much of the phase actually remains, then drain over
            // just that time — not a fresh full duration — so a bar mounted
            // mid-phase lines up with reality.
            const remaining = Math.max(0, endsAt! - Date.now());
            progress.setValue(remaining / total!);
            const animation = Animated.timing(progress, {
                toValue: 0,
                duration: remaining,
                // Linear so it drains at a constant rate over the whole phase; the
                // default ease-in-out would crawl at the ends.
                easing: Easing.linear,
                // scaleX runs on the native driver (UI thread), so the drain stays
                // smooth over a long play phase even while the 1s timeLeft tick
                // re-renders every NowPlayingContext consumer. The end time only
                // changes on phase start/pause/resume, so the animation isn't
                // restarted per tick.
                useNativeDriver: true,
            });
            animation.start();
            return () => animation.stop();
        }
        progress.setValue(0);
    }, [active, endsAt, total]);

    if(!active) {
        return null;
    }

    return (
        <View style={[styles.track, { height, backgroundColor: trackColor }, style]}>
            <Animated.View
                style={[
                    styles.fill,
                    { backgroundColor: pausing ? pauseColor : playColor, transform: [{ scaleX: progress }] },
                ]}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    track: {
        width: '100%',
        borderRadius: 999,
        overflow: 'hidden',
    },
    fill: {
        width: '100%',
        height: '100%',
        borderRadius: 999,
        // Scale from the left edge so scaleX drains right-to-left instead of
        // shrinking toward the centre.
        transformOrigin: 'left',
    },
});
