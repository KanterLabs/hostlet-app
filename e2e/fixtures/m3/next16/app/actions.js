"use server";
export async function echoOwnedFixture(formData) { return { value: String(formData.get("value") || "").slice(0, 80), release: "next16-v1" }; }
