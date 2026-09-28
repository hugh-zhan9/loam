"use client";

/**
 * Why the images last pasted or dropped did not all land.
 *
 * The editor surface words the message — only it knows the batch and where it
 * stopped — but the shell around it shows the bar, because the commonest reason
 * an image is refused is that its tab was closed or switched to a file that is
 * not Markdown while it was stored, and the surface is gone by then. The shell
 * is still there to say so.
 */
export function ImageFailureBar({
    message,
    onDismiss,
}: {
    message: string | null;
    onDismiss: () => void;
}) {
    if (message === null) return null;

    return (
        <div
            data-mdx-image-notice="failed"
            // A one-off outcome of something the user just did.
            role="alert"
            className="flex shrink-0 items-start gap-3 border-b border-error/30 bg-error/10 px-3 py-2 text-sm"
        >
            <span className="min-w-0 flex-1 break-words">{message}</span>
            <button
                type="button"
                className="shrink-0 text-xs text-base-content/70 underline-offset-2 hover:text-base-content hover:underline"
                onClick={onDismiss}
            >
                关闭
            </button>
        </div>
    );
}
