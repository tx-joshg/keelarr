import { StackarrError } from "../errors.js";

/**
 * The value an Arr returns in place of a secret it will not disclose.
 *
 * This is why a fetched object cannot simply be copied into a create call: the
 * copy carries the mask, the app stores the mask, and the new client fails
 * every request with 403. Secrets must be supplied from the source we read them
 * from, not round-tripped through the app that is hiding them.
 */
export const MASKED_VALUE = "********";

function findSchema(schemas, implementation) {
  const match = (schemas || []).find(
    (entry) => String(entry?.implementation || "").toLowerCase() === String(implementation).toLowerCase()
  );

  if (!match) {
    throw new StackarrError(`This app does not offer a ${implementation} integration.`, { statusCode: 422 });
  }

  return match;
}

/**
 * Patches values into the app's own schema template.
 *
 * Only named fields are touched; everything else keeps the app's default, which
 * is how categories, priorities, and sync options stay whatever the app thinks
 * they should be rather than whatever Stackarr was written to assume.
 */
function patchFields(schema, values) {
  return (schema.fields || []).map((field) =>
    Object.hasOwn(values, field.name) ? { ...field, value: values[field.name] } : { ...field }
  );
}

export function buildDownloadClientPayload(schemas, { name, host, port, apiKey, useSsl = false }) {
  const schema = findSchema(schemas, "Sabnzbd");

  return {
    ...schema,
    name,
    enable: true,
    fields: patchFields(schema, { host, port, useSsl, apiKey })
  };
}

export function buildApplicationPayload(schemas, { implementation, name, prowlarrUrl, baseUrl, apiKey }) {
  const schema = findSchema(schemas, implementation);

  return {
    ...schema,
    name,
    // addOnly rather than fullSync: Prowlarr pushes its indexers into the app
    // but never removes what is already there, so an indexer configured by hand
    // in Radarr survives. Choosing fullSync here would delete it.
    syncLevel: "addOnly",
    fields: patchFields(schema, { prowlarrUrl, baseUrl, apiKey })
  };
}

/**
 * Collapses an app's validation response into one sentence.
 *
 * Arr apps answer a failed test with an array of per-field complaints, and the
 * useful part is usually `detailedDescription` — "Unable to connect to SABnzbd"
 * says far less than the same message with the address it could not reach.
 */
export function describeValidation(payload) {
  if (!Array.isArray(payload)) {
    return null;
  }

  const messages = payload
    .filter((entry) => entry?.isWarning !== true)
    .map((entry) => entry?.detailedDescription || entry?.errorMessage)
    .filter(Boolean);

  return messages.length ? [...new Set(messages)].join("; ") : null;
}
