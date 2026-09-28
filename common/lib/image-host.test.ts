import { describe, expect, it } from "vitest";
import {
    defaultImageHostConfig,
    imageHostConfigUpdate,
    type PublicImageHostConfig,
} from "./image-host";

function withSecrets(): PublicImageHostConfig {
    const config = defaultImageHostConfig();
    return {
        ...config,
        s3: { ...config.s3, hasSecretAccessKey: true },
        github: { ...config.github, hasToken: true },
    };
}

describe("imageHostConfigUpdate", () => {
    it("keeps stored secrets when their fields are left blank", () => {
        const update = imageHostConfigUpdate(withSecrets(), {
            secretAccessKey: "  ",
            token: "",
        });

        expect(update.s3.preserveSecretAccessKey).toBe(true);
        expect(update.github.preserveToken).toBe(true);
    });

    it("replaces a stored secret with what was typed", () => {
        const update = imageHostConfigUpdate(withSecrets(), {
            secretAccessKey: "new-secret",
            token: "new-token",
        });

        expect(update.s3).toMatchObject({
            secretAccessKey: "new-secret",
            preserveSecretAccessKey: false,
        });
        expect(update.github).toMatchObject({
            token: "new-token",
            preserveToken: false,
        });
    });

    it("preserves nothing when nothing was stored", () => {
        const update = imageHostConfigUpdate(defaultImageHostConfig(), {
            secretAccessKey: "",
            token: "",
        });

        expect(update.s3.preserveSecretAccessKey).toBe(false);
        expect(update.github.preserveToken).toBe(false);
    });

    it("sends no has-flags back to the backend", () => {
        const update = imageHostConfigUpdate(withSecrets(), {
            secretAccessKey: "",
            token: "",
        });

        expect(update.s3).not.toHaveProperty("hasSecretAccessKey");
        expect(update.github).not.toHaveProperty("hasToken");
    });
});
