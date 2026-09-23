import { keymap } from "@milkdown/kit/prose/keymap";
import { TextSelection, type Command } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** An endpoint at a heading's start selects none of its text or formatting. */
const deleteBeforeHeading: Command = (state, dispatch) => {
    const { selection } = state;
    if (!(selection instanceof TextSelection) || selection.empty) return false;
    const { $from, $to } = selection;
    if (
        $to.parent.type.name !== "heading" ||
        $to.parentOffset !== 0 ||
        // With no surviving prefix, ProseMirror already keeps the defining
        // heading and removes the fully selected blocks before it.
        $from.parentOffset === 0 ||
        $from.sameParent($to)
    ) return false;

    // Stop outside the heading, so deletion cannot join it into the preceding
    // textblock and silently replace its type with that block's paragraph type.
    const tr = state.tr.deleteRange($from.pos, $to.before());
    tr.setSelection(
        TextSelection.near(tr.doc.resolve(tr.mapping.map($from.pos)), -1),
    );
    dispatch?.(tr.scrollIntoView());
    return true;
};

export const headingSelectionProsePlugin = $prose(() =>
    keymap({ Backspace: deleteBeforeHeading, Delete: deleteBeforeHeading }),
);
