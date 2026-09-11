import React, { useState, useEffect, useContext, useMemo } from "react";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text } from '@rneui/themed';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PlaylistListItem } from "../components/PlaylistListItem";
import { AppContext} from '../context/SpotifyContext';
import { LoadingScreen } from "../components/Loading";
import { ErrorScreen } from "../components/Error";
import { getUserPlaylists } from "../helpers/data";

type Filter = 'all' | 'mine' | 'collaborative';
type Sort = 'recent' | 'name';

const pinStorageKey = (userId?: string) => `@tempofy:pinned-playlists:${userId ?? 'anonymous'}`;

export const PlaylistScreen = ({ navigation }: any) => {
    const { isConnected, api, user } = useContext(AppContext);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [items, setItems] = useState<SpotifyApi.PlaylistObjectSimplified[]>([]);
    const [pinnedIds, setPinnedIds] = useState<string[]>([]);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [sort, setSort] = useState<Sort>('recent');
    
    const fetchItems = async () => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await getUserPlaylists(api);
            setItems(result);
        } catch (err: any) {
            setError(err.message);
        }
        setLoading(false);
    };

    const handleItemClick = (item: SpotifyApi.PlaylistObjectSimplified) => {
        navigation.navigate('Tracks', {parent: item});
    }

    useEffect(() => {
        if (isConnected) {
            fetchItems();
        }
    }, [isConnected]);

    useEffect(() => {
        AsyncStorage.getItem(pinStorageKey(user.id))
            .then((saved) => setPinnedIds(saved ? JSON.parse(saved) : []))
            .catch(() => setPinnedIds([]));
    }, [user.id]);

    const togglePin = async (playlist: SpotifyApi.PlaylistObjectSimplified) => {
        const nextPinnedIds = pinnedIds.includes(playlist.id)
            ? pinnedIds.filter((id) => id !== playlist.id)
            : [...pinnedIds, playlist.id];
        setPinnedIds(nextPinnedIds);
        try {
            await AsyncStorage.setItem(pinStorageKey(user.id), JSON.stringify(nextPinnedIds));
        } catch {
            // Keep the change for this session even if local persistence is unavailable.
        }
    };

    const visibleItems = useMemo(() => {
        const normalisedQuery = query.trim().toLocaleLowerCase();
        return [...items]
            .filter((item) => {
                if (filter === 'mine' && item.owner?.id !== user.id) return false;
                if (filter === 'collaborative' && !item.collaborative) return false;
                return !normalisedQuery || [item.name, item.description, item.owner?.display_name]
                    .filter(Boolean)
                    .some((value) => value!.toLocaleLowerCase().includes(normalisedQuery));
            })
            .sort((a, b) => {
                const pinDifference = Number(pinnedIds.includes(b.id)) - Number(pinnedIds.includes(a.id));
                if (pinDifference) return pinDifference;
                return sort === 'name' ? a.name.localeCompare(b.name) : 0;
            });
    }, [filter, items, pinnedIds, query, sort, user.id]);

    if(loading) return <LoadingScreen />;
    if(error) return <ErrorScreen message={error} />;

    return (
        <FlatList
            data={visibleItems}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
                <View style={styles.header}>
                    <Text h3>Your library</Text>
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        placeholder="Search playlists"
                        placeholderTextColor="#8e9098"
                        style={styles.search}
                        returnKeyType="search"
                    />
                    <View style={styles.row}>
                        <FilterButton label="All" selected={filter === 'all'} onPress={() => setFilter('all')} />
                        <FilterButton label="Yours" selected={filter === 'mine'} onPress={() => setFilter('mine')} />
                        <FilterButton label="Collaborative" selected={filter === 'collaborative'} onPress={() => setFilter('collaborative')} />
                    </View>
                    <View style={styles.sortRow}>
                        <Text style={styles.resultCount}>{visibleItems.length} playlists</Text>
                        <Pressable onPress={() => setSort(sort === 'recent' ? 'name' : 'recent')}>
                            <Text style={styles.sort}>Sort: {sort === 'name' ? 'Name' : 'Spotify order'}</Text>
                        </Pressable>
                    </View>
                </View>
            }
            ListEmptyComponent={<Text style={styles.empty}>No playlists match this view.</Text>}
            renderItem={({ item }) => <PlaylistListItem
                onPress={handleItemClick}
                onTogglePin={togglePin}
                isPinned={pinnedIds.includes(item.id)}
                item={item}
            />}
        />
    )
}

const FilterButton = ({ label, selected, onPress }: { label: string, selected: boolean, onPress: () => void }) => (
    <Pressable onPress={onPress} style={[styles.filterButton, selected && styles.filterButtonSelected]}>
        <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{label}</Text>
    </Pressable>
);

const styles = StyleSheet.create({
    header: { padding: 16, gap: 12 },
    search: { backgroundColor: '#2a2b33', borderRadius: 8, color: '#fff', fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    filterButton: { borderColor: '#666a78', borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
    filterButtonSelected: { backgroundColor: '#4f6cdd', borderColor: '#4f6cdd' },
    filterText: { fontSize: 13 },
    filterTextSelected: { fontWeight: '700' },
    sortRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    resultCount: { color: '#a7a9b2', fontSize: 13 },
    sort: { color: '#b9c5ff', fontSize: 13 },
    empty: { color: '#a7a9b2', padding: 24, textAlign: 'center' },
});
