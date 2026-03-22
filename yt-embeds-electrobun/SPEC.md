abstract out the video player that hides recommendations into areusable component if it's nto already and use it for all video players.



Video mods that we want to support:

1. individual video page: simple UI only video player is visible, with link back to home. a large "play again" button below the video if it has ended. if not, the big button can be "play/pause" depending on if it's playing or paused.

2. playlist video page: have 3 display modes, either left pane showing list, top pane showing horizontal scrolling list (fade contents at the edges to indicate scrolling), or a dropdown mod where list takes minimal space, highlighting only current video.

3. homepage: shows links to pinned videos and playlists. can unpin from there

4. discover page: more content shown, i will later provide api's to pull data from, for now we will hardcode a few examples for each type (invidual and playlists). user can pin/unpin content




hmmm i mgetting a better idea

let's do this as well:

each video or playlist is a "node" and can have children an d parent relationships. this can be used to organize content in hierarchies.


if there are children, show thumbnail links to them below the video, hidden under a "3 children" or whatever expand button (dont show them automatically, keep distraction free)


