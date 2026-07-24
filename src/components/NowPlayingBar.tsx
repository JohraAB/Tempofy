import React, { useContext, useEffect, useState } from "react";
import { TouchableOpacity, View } from "react-native";
import { AppContext } from "../context/SpotifyContext";
import { Icon, makeStyles, Text } from '@rneui/themed';
import { FullScreen } from "./FullScreen";
import { NowPlayingContext } from "../context/NowPlayingContext";
import { PauseProgressBar } from "./PauseProgressBar";
import { getAnalytics, logEvent } from '@react-native-firebase/analytics';

export const NowPlayingBar = () => {
    const { isConnected, playerState, remote } = useContext(AppContext);
    const { timeLeft, isAutoPausing, cancelAutoResume } = useContext(NowPlayingContext);
    const styles = useStyles();

    const [modalVisible, setModalVisible] = useState(false);
    const secondsLeft = timeLeft ? Math.floor(timeLeft / 1000) : null;

    useEffect(() => {
        if(modalVisible) {
            logEvent(getAnalytics(),'show_fullscreen');
        }
    },[modalVisible])

    if(!isConnected) {
        return null;
    }

    const togglePlayPause = () => {
        if(isAutoPausing) {
            // The button shows as playing during the rest gap; a tap keeps it
            // paused (blocks the auto-resume) so the instructor stays in control.
            cancelAutoResume();
        } else if(playerState?.isPaused) {
            remote.resume();
        } else {
            remote.pause();
        }
        logEvent(getAnalytics(),'toggle_play_pause');
    }

    const getValidTimeLeft = (value: number | null) => {
        return value && value > 0 ? (value+'s') : '-'
    }

    if(playerState) {
        return (
            <>
                <TouchableOpacity style={styles.container} onPress={() => setModalVisible(!modalVisible)}>
                    <Icon name={'keyboard-arrow-up'}/>
                    <View style={styles.trackContainer}>
                        <Text>{playerState.track.artist.name} - {playerState.track.name}</Text>
                        <Text>{getValidTimeLeft(secondsLeft)}</Text>
                    </View>
                    <TouchableOpacity style={styles.controlIcon} onPress={() => togglePlayPause()}>
                        <Icon raised name={(isAutoPausing || !playerState.isPaused) ? 'pause' : 'play-arrow'}/>
                    </TouchableOpacity>
                    <PauseProgressBar
                        height={3}
                        fillColor={'#ffffff'}
                        trackColor={'rgba(0,0,0,0.2)'}
                        style={styles.pauseBar}
                    />
                </TouchableOpacity>
                <FullScreen 
                    playerState={playerState}
                    visible={modalVisible}
                    onRequestClose={() => {
                        setModalVisible(!modalVisible);
                    }}
                />
            </>
        )
    }

    return null;
}

const useStyles = makeStyles((theme) => ({
    container: {
        backgroundColor: theme.colors.primary,
        alignContent: 'space-between',
        alignItems: 'center',
        flexDirection: 'row'
    },
    trackContainer: {
        flex: 1,
        flexDirection: 'column',
        padding: 10
    },
    controlIcon: {
    },
    pauseBar: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        width: undefined,
        borderRadius: 0,
    },
}));
  