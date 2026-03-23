export type NodeKind = "video" | "playlist";

type BaseNode = {
  id: string;
  kind: NodeKind;
  title: string;
  description: string;
  channel: string;
  children: string[];
  parents: string[];
  accent: string;
};

export type VideoNode = BaseNode & {
  kind: "video";
  videoId: string;
  durationLabel: string;
};

export type PlaylistNode = BaseNode & {
  kind: "playlist";
  videoIds: string[];
};

export type ContentNode = VideoNode | PlaylistNode;

export type PlaylistDisplayMode = "left" | "top" | "dropdown";

const nodes: ContentNode[] = [
  {
    id: "beamng-dangerous-driving-9",
    kind: "video",
    title: "BeamNG Drive - Realistic Car Crashes | Dangerous Driving #9",
    description: "A standalone video node used for the individual video page flow.",
    channel: "digital DRIVE",
    videoId: "C6ZNrzvaci0",
    durationLabel: "9:51",
    children: ["crash-course-marathon", "video-lab-demo"],
    parents: ["discover-home"],
    accent: "sunset"
  },
  {
    id: "video-lab-demo",
    kind: "video",
    title: "YouTube API Demo Clip",
    description: "A short demo video used as a lightweight second item in playlists.",
    channel: "YouTube Developers",
    videoId: "M7lc1UVf-VE",
    durationLabel: "4:18",
    children: ["starter-playlist"],
    parents: ["crash-course-marathon", "discover-home"],
    accent: "ocean"
  },
  {
    id: "starter-video",
    kind: "video",
    title: "Sample Embedded Video",
    description: "A generic sample video node for the discover surface.",
    channel: "Embed Samples",
    videoId: "ysz5S6PUM-U",
    durationLabel: "0:10",
    children: [],
    parents: ["starter-playlist", "discover-home"],
    accent: "mint"
  },
  {
    id: "embed-disabled-test",
    kind: "video",
    title: "Embed Disabled Test Video",
    description: "Test node for video ID yvr9TXXc9Hw so we can compare the local downloader and YouTube webview paths.",
    channel: "Manual Test",
    videoId: "yvr9TXXc9Hw",
    durationLabel: "Unknown",
    children: [],
    parents: ["discover-home"],
    accent: "graphite"
  },
  {
    id: "crash-course-marathon",
    kind: "playlist",
    title: "Crash Course Marathon",
    description: "A playlist node that demonstrates the three playlist display modes.",
    channel: "digital DRIVE",
    videoIds: ["beamng-dangerous-driving-9", "video-lab-demo", "starter-video"],
    children: ["starter-playlist"],
    parents: ["discover-home"],
    accent: "ember"
  },
  {
    id: "starter-playlist",
    kind: "playlist",
    title: "Starter Playlist",
    description: "A smaller playlist node that links back into the node graph.",
    channel: "Embed Samples",
    videoIds: ["starter-video", "video-lab-demo"],
    children: [],
    parents: ["crash-course-marathon"],
    accent: "violet"
  },
  {
    id: "discover-home",
    kind: "playlist",
    title: "Discover Home",
    description: "A root grouping node for the hardcoded discover content.",
    channel: "Local Library",
    videoIds: ["beamng-dangerous-driving-9", "video-lab-demo", "starter-video", "embed-disabled-test"],
    children: ["beamng-dangerous-driving-9", "video-lab-demo", "starter-video", "embed-disabled-test", "crash-course-marathon"],
    parents: [],
    accent: "graphite"
  }
];

const nodeMap = new Map(nodes.map((node) => [node.id, node]));

export function getAllNodes(): ContentNode[] {
  return nodes.filter((node) => node.id !== "discover-home");
}

export function getDiscoverNodes(): ContentNode[] {
  return getAllNodes();
}

export function getNode(nodeId: string): ContentNode | undefined {
  return nodeMap.get(nodeId);
}

export function getVideoNode(nodeId: string): VideoNode | undefined {
  const node = getNode(nodeId);
  return node?.kind === "video" ? node : undefined;
}

export function getPlaylistNode(nodeId: string): PlaylistNode | undefined {
  const node = getNode(nodeId);
  return node?.kind === "playlist" ? node : undefined;
}

export function getPlaylistItems(playlist: PlaylistNode): VideoNode[] {
  return playlist.videoIds
    .map((videoNodeId) => getVideoNode(videoNodeId))
    .filter((node): node is VideoNode => Boolean(node));
}

export function getChildren(node: ContentNode): ContentNode[] {
  return node.children
    .map((nodeId) => getNode(nodeId))
    .filter((child): child is ContentNode => Boolean(child));
}

export function getParents(node: ContentNode): ContentNode[] {
  return node.parents
    .map((nodeId) => getNode(nodeId))
    .filter((parent): parent is ContentNode => Boolean(parent));
}

export function getNodeUrl(node: ContentNode): string {
  return node.kind === "video" ? `#/video/${node.id}` : `#/playlist/${node.id}`;
}

export function getVideoThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi_webp/${videoId}/hqdefault.webp`;
}

export function getNodeThumbnail(node: ContentNode): string {
  if (node.kind === "video") {
    return getVideoThumbnail(node.videoId);
  }

  const firstVideo = getPlaylistItems(node)[0];
  return firstVideo ? getVideoThumbnail(firstVideo.videoId) : "";
}
