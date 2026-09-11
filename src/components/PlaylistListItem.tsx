import React from "react";
import { ListItem, Avatar, Icon } from '@rneui/themed'

export const PlaylistListItem: React.FC<{
    onPress?: (item: SpotifyApi.PlaylistObjectSimplified) => void,
    onLongPress?: (item: SpotifyApi.PlaylistObjectSimplified) => void,
    onTogglePin?: (item: SpotifyApi.PlaylistObjectSimplified) => void,
    isPinned?: boolean,
    item: SpotifyApi.PlaylistObjectSimplified
}> = ({
    item,
    onPress,
    onLongPress,
    onTogglePin,
    isPinned = false,
  }) => {
    const {
        name,
        images
    } = item;
    const previewImage = images && images.length > 0 ? images[images.length-1] : null;
    return (
        <ListItem
            onPress={() => onPress && onPress(item)}
            onLongPress={() => onLongPress && onLongPress(item)}
            bottomDivider
        >
            {previewImage &&
                <Avatar
                    source={{ uri: previewImage.url }}
                />
            }
            <ListItem.Content>
                <ListItem.Title>{name}</ListItem.Title>
                <ListItem.Subtitle numberOfLines={1}>
                    {item.owner?.display_name ? `${item.owner.display_name} · ` : ''}
                    {item.tracks?.total ?? 0} tracks
                    {item.collaborative ? ' · Collaborative' : ''}
                </ListItem.Subtitle>
            </ListItem.Content>
            {onTogglePin && <Icon
                name={isPinned ? 'star' : 'star-outline'}
                type="material"
                color={isPinned ? '#f5c542' : undefined}
                onPress={() => onTogglePin(item)}
            />}
            <ListItem.Chevron />
        </ListItem>
    )
  }
