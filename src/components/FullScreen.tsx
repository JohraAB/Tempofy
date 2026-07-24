import React, { useContext, useEffect, useState } from "react";
import { Modal, View, StyleSheet, SafeAreaView, TouchableOpacity, Dimensions } from "react-native";
import { Icon, Text } from '@rneui/themed';
import { PlayerState } from "../helpers/types";
import { SettingsContext } from "../context/SettingsContext";
import { AppContext } from "../context/SpotifyContext";
import { QueueContext } from "../context/QueueContext";
import { NowPlayingContext } from "../context/NowPlayingContext";
import { TempoContext } from "../context/TempoContext";
import { Background } from "./Background";
import { PauseProgressBar } from "./PauseProgressBar";

export const FullScreen: React.FC<{ playerState: PlayerState, visible: boolean, onRequestClose: () => void }> = ({
    playerState,
    visible,
    onRequestClose
  }) => {
    
    const { autoSkipMode, setAutoSkipMode, autoSkipTime, setAutoSkipTime } = useContext(SettingsContext);
    const { remote } = useContext(AppContext);
    const { canSkipNext, canSkipPrevious, currentTrack } = useContext(QueueContext);
    const { skipToNext, skipToPrevious, timeLeft, isAutoPausing, cancelAutoResume } = useContext(NowPlayingContext);
    const { selectedTempo, setSelectedTempo } = useContext(TempoContext);
    const [userChangedTempo, setUserChangedTempo] = useState(false);

    const secondsLeft = timeLeft ? Math.floor(timeLeft / 1000) : null;

    useEffect(() => {
        if(userChangedTempo) {
            setUserChangedTempo(false);
        }
    },[currentTrack])

    const toggleAutoSkipMode = () => {
        setAutoSkipMode(autoSkipMode == 2 ? 0 : autoSkipMode+1);
    }

    const toggleAutoSkipTime = () => {
        const step = 15000;
        const newValue = autoSkipTime + step
        setAutoSkipTime(newValue > 120000 ? step : newValue);
    }

    const togglePlayPause = () => {
        if(isAutoPausing) {
            // Button shows as playing during the rest gap; a tap keeps it paused
            // (blocks the auto-resume) so the instructor stays in control.
            cancelAutoResume();
        } else if(playerState.isPaused) {
            remote.resume();
        } else {
            remote.pause();
        }
    }

    const onSkipPrevious = () => {
        // App-driven previous through our own history, so it reliably goes back a
        // track instead of restarting the current one (Spotify's skip-previous
        // behaviour) — and applies the same intro-skip as a forward skip.
        skipToPrevious();
    }

    const onChangeTempo = (increment: number) => {
        setSelectedTempo((tempo: number) => tempo+increment);
        setUserChangedTempo(true);
    }

    const getValidTimeLeft = (value: number | null) => {
        return value && value > 0 ? value : '-'
    }

    return (
        <Modal
            animationType="slide"
            presentationStyle="fullScreen"
            supportedOrientations={["portrait","landscape"]}
            visible={visible}
            onRequestClose={onRequestClose}
        >
            <Background>
                <SafeAreaView style={styles.container}>
                    <TouchableOpacity style={styles.controlIcon} onPress={onRequestClose}>
                        <Icon size={40} name={'keyboard-arrow-down'}/>
                    </TouchableOpacity>
                    <View style={styles.coverContainer}>
                        <Text h2 style={[styles.coverText, {fontWeight: 'bold'}]}>{playerState.track.name}</Text>
                        <Text h3 style={styles.coverText}>{playerState.track.artist.name}</Text>
                    </View>
                    <View style={styles.controlButtons}>
                        <TouchableOpacity style={[styles.controlIcon,{opacity: canSkipPrevious ? 1 : 0.2}]} disabled={!canSkipPrevious} onPress={() => onSkipPrevious()}>
                            <Icon size={40} name={'skip-previous'}/>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.controlIcon} onPress={() => togglePlayPause()}>
                            <Icon size={40} name={(isAutoPausing || !playerState.isPaused) ? 'pause' : 'play-arrow'}/>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.controlIcon,{opacity: canSkipNext ? 1 : 0.2}]} disabled={!canSkipNext} onPress={() => skipToNext()}>
                            <Icon size={40} name={'skip-next'}/>
                        </TouchableOpacity>
                    </View>
                    <View style={styles.controlButtons}>
                        <TouchableOpacity style={styles.controlIcon} onPress={() => onChangeTempo(-2)}>
                            <Text h1>-</Text>
                        </TouchableOpacity>
                        <View style={styles.controlIcon}>
                            <Text h1>
                                {userChangedTempo ? selectedTempo : (
                                    currentTrack ? currentTrack.tempo : '-'
                                )}
                            </Text>
                            <Text>bpm</Text>
                        </View>
                        <TouchableOpacity style={styles.controlIcon} onPress={() => onChangeTempo(2)}>
                            <Text h1>+</Text>
                        </TouchableOpacity>
                    </View>
                    <View style={styles.controlButtons}>
                        <View style={styles.controlIcon}>
                            <Text h4>{getValidTimeLeft(secondsLeft)}</Text>
                            <Text>sec</Text>
                        </View>
                        <TouchableOpacity style={styles.controlIcon} onPress={() => toggleAutoSkipMode()}>
                            <Icon size={40} name={autoSkipMode > 0 ? (autoSkipMode == 1 ? 'timer' : 'pause') : 'timer-off'}/>
                            <Text>{autoSkipMode > 0 ? (autoSkipMode == 1 ? 'Skip timer' : 'Pause timer') : 'Play track'}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.controlIcon} onPress={() => toggleAutoSkipTime()}>
                            <View>
                            <Text h4>{autoSkipTime/1000}</Text>
                            <Text>sec</Text>
                            </View>
                        </TouchableOpacity>
                    </View>
                    <PauseProgressBar height={8} style={styles.pauseBar} />
                </SafeAreaView>
            </Background>
        </Modal>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1
    },
    coverContainer: {
        flex: 0
    },
    coverImage: {
        width: Dimensions.get('window').width,
        height: Dimensions.get('window').width
    },
    coverText: {

    },
    pauseBar: {
        marginHorizontal: 30,
        marginBottom: 20,
        width: undefined,
    },
    controlButtons: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'space-evenly'
    },
    controlIcon: {
        alignSelf: 'center',
        alignItems: 'center',
        padding: 10,
        width: 100
    },
});