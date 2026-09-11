import { getPublicSuffix } from "tldts";

/** Locate the label that identifies a registrant, including private hosting suffixes. */
export function registrableLabelIndex(labels: string[]): number {
  // tldts expects a hostname. The probe keeps each wildcard in its existing label;
  // it is only used to identify the suffix, never as an emitted matching rule.
  const probe = labels.map((label) => label.replace(/\*/g, "wildcard")).join(".");
  const suffix = getPublicSuffix(probe, { allowPrivateDomains: true });
  return suffix ? labels.length - suffix.split(".").length - 1 : -1;
}

export function hasRegistrableDomainAnchor(value: string): boolean {
  const labels = value.split(".");
  const index = registrableLabelIndex(labels);
  const label = labels[index];
  return index >= 0 && label !== undefined && /[a-z0-9]/i.test(label);
}
