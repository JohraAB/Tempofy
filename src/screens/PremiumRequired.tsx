import React, { useContext, useEffect } from 'react';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import * as Linking from 'expo-linking';
import { AppContext } from '../context/SpotifyContext';
import { StyleSheet, Modal, Image, View } from "react-native";
import { Button, Text } from '@rneui/themed';
import { Background } from '../components/Background';
import { getAnalytics, logEvent } from '@react-native-firebase/analytics';

// Shown when the user authenticated successfully but their Spotify account is
// not Premium. Spotify's App Remote only allows on-demand playback for Premium
// accounts, so without this a free user reaches the app and every "play" is a
// silent no-op. This blocks that dead-end with an explanation and a way out.
export const PremiumRequiredScreen = () => {
    const { isConnected, isPremium, user, disconnect } = useContext(AppContext);

    const visible = isConnected && isPremium === false;

    useEffect(() => {
        if (visible) {
            logEvent(getAnalytics(), 'spotify_not_premium', { product: user?.product ?? 'unknown' });
        }
    }, [visible, user?.product]);

    return (
        <Modal
            animationType="slide"
            presentationStyle="overFullScreen"
            supportedOrientations={["portrait", "landscape"]}
            visible={visible}
        >
            <Background style={styles.container}>
                <View style={styles.top}>
                    <Image
                        style={styles.logo}
                        source={require('../../assets/transparent-icon.png')}
                    />
                </View>
                <View style={styles.center}>
                    <Text h1>Spotify Premium required</Text>
                    <Text style={styles.body}>
                        Tempofy plays music through Spotify, and Spotify only lets apps
                        control playback for Premium accounts. Your account isn't Premium,
                        so tracks won't start from here.
                    </Text>
                    <Button
                        onPress={() => Linking.openURL('https://www.spotify.com/premium/')}
                        title="Get Spotify Premium"
                        icon={{
                            name: 'spotify',
                            type: 'font-awesome'
                        }}
                        iconRight
                    />
                    <Button
                        type="clear"
                        onPress={() => disconnect()}
                        title="Use a different account"
                    />
                </View>
                <View style={styles.bottom}>
                    <Text>{Constants.expoConfig?.version} - {Constants.nativeAppVersion} ({Updates.channel})</Text>
                    <Text>{Updates.updateId}</Text>
                </View>
            </Background>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        justifyContent: 'space-evenly',
        alignItems: 'center',
    },
    top: {
        flex: 2,
        justifyContent: 'space-evenly',
    },
    logo: {
        width: 150,
        height: 150,
    },
    center: {
        flex: 2,
        alignItems: 'center',
        justifyContent: 'space-evenly',
        paddingHorizontal: 24,
    },
    body: {
        textAlign: 'center',
    },
    bottom: {
        flex: 0,
        alignItems: 'center',
    }
});
