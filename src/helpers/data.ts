import SpotifyWebApi from "spotify-web-api-node";
import { TrackObject } from "./types";

export const getUserPlaylists = async (api: any) => {
    let requests = await createAllRequests(
        api,
        'getUserPlaylists',
        undefined,
        {},
        'items(uri,id,name,description,images,owner(id,display_name),tracks(total),collaborative,public)'
    );
    const responses: any = await Promise.all(requests);
    const itemMap = new Map<string, any>();
    for (const response of responses) {
        const items = response?.body?.items || [];
        for (const item of items) {
            if (item && item.id && !itemMap.has(item.id)) {
                itemMap.set(item.id, item);
            }
        }
    }
    return Array.from(itemMap.values());
}

export const getPlaylistTracks = async (api: SpotifyWebApi, allTempos: any, id: string) => {
    let requests = await createAllRequests(api, 'getPlaylistTracks', id, {market:'from_token'},'items(track(id,name,uri,is_playable,artists(name)))', async (data: any) => {
        const trackList = data.body.items.map((data:any) => data.track).filter((data:any) => data && data.id != null && data.is_playable);
        const idList = trackList.map((item: any) => item.id);
        const audioData = await api.getAudioFeaturesForTracks(idList);
        const newItems: TrackObject[] = trackList.map((item_1: any, index: number) => {
            const tempofyTempo = allTempos[item_1.id];
            const tempo = tempofyTempo ? tempofyTempo.tempo : (audioData.body.audio_features[index] ? audioData.body.audio_features[index].tempo : null);
            return {
                ...item_1,
                tempo: tempo ? parseInt(tempo.toString()) : null
            };
        });
        return newItems;
    } );
    
    const responses: any = await Promise.all(requests);
    const itemMap = new Map<string, TrackObject>();
    for (const items of responses) {
        for (const item of (items || [])) {
            if (item && item.id && !itemMap.has(item.id)) {
                itemMap.set(item.id, item);
            }
        }
    }
    return Array.from(itemMap.values());
}

const createAllRequests = async (api: any, request: string, args: any, input: any, fields?: string, onRequestComplete?: any) => {
    const initialOptions = {
        fields: 'total,limit'
    };
    const response: any = args === undefined
        ? await api[request](initialOptions)
        : await api[request](args, initialOptions);
    var requests = [];
    const numRequests = Math.ceil(response.body.total/response.body.limit);
    
    var count = 0;
    do {
        const options = {
                offset: count*parseInt(response.body.limit),
                limit: response.body.limit,
                fields: fields,
                ...input
            };
        const pagedRequest = args === undefined
            ? api[request](options)
            : api[request](args, options);
        requests.push(pagedRequest.then(onRequestComplete))
        count++
    } while (count < numRequests)
    return requests;
}

export function shuffle<T>(array: T[]): T[] {
    let currentIndex = array.length,  randomIndex;

    // While there remain elements to shuffle.
    while (currentIndex != 0) {
  
      // Pick a remaining element.
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex--;
  
      // And swap it with the current element.
      [array[currentIndex], array[randomIndex]] = [
        array[randomIndex], array[currentIndex]];
    }
  
    return array;
};
