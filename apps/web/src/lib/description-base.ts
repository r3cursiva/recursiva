/**
 * Whether the description editor may take the row's `tx` as the text it edits from. Not under a save on its way: the row
 * then shows our text with the `tx` of whatever the server last sent, possibly someone else's, and naming that would
 * overwrite it unseen if our save is refused. Not under unsaved typing either, unless the text is our own save coming back:
 * that typing grew from what was there before.
 */
export const followsServer = (saving: boolean, typing: boolean, ownText: boolean): boolean => !saving && (!typing || ownText);
