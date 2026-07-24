import React, { useContext, useEffect, useRef } from "react";
import { Animated, StyleSheet, View, ViewStyle } from "react-native";
import { NowPlayingContext } from "../context/NowPlayingContext";
import { SettingsContext } from "../context/SettingsContext";

// A bar that drains over the Pause-mode rest gap so the instructor can see how
// much of the pause is left before playback auto-resumes. It's driven off the
// same isAutoPausing flag the play/pause button reads, and the gap always lasts
// pauseTime (see holdPauseGap), so a single timing animation tracks it exactly.
export const PauseProgressBar: React.FC<{
    height?: number;
    fillColor?: string;
    trackColor?: string;
    style?: ViewStyle;
}> = ({
    height = 6,
    fillColor = '#4f6cdd',
    trackColor = 'rgba(255,255,255,0.15)',
    style,
}) => {
    const { isAutoPausing } = useContext(NowPlayingContext);
    const { pauseTime } = useContext(SettingsContext);
    const progress = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if(isAutoPausing) {
            progress.setValue(1);
            const animation = Animated.timing(progress, {
                toValue: 0,
                duration: pauseTime,
                // Width can't animate on the native driver; the gap is short and
                // occasional, so a JS-driven bar is fine and doesn't re-render
                // any context consumers.
                useNativeDriver: false,
            });
            animation.start();
            return () => animation.stop();
        }
        progress.setValue(0);
    }, [isAutoPausing, pauseTime]);

    if(!isAutoPausing) {
        return null;
    }

    const width = progress.interpolate({
        inputRange: [0, 1],
        outputRange: ['0%', '100%'],
    });

    return (
        <View style={[styles.track, { height, backgroundColor: trackColor }, style]}>
            <Animated.View style={[styles.fill, { width, backgroundColor: fillColor }]} />
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
        height: '100%',
        borderRadius: 999,
    },
});
