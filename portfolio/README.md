# Portfolio publishing boundary

This is an unimplemented product boundary, not a runnable package.

The content model will cover profile, introduction, target role, skills, résumé,
contact links, ordered project references, contribution, technical decisions,
approved evidence and publication visibility. Three initial layouts share it.

Keep editable drafts and immutable approved publication revisions separate. Reuse
project/deployment facts instead of storing a disconnected copy of live URLs.
Private-source access does not authorize public content or screenshot publication.
Updates may refresh authorized deployment facts and propose narrative changes;
they must not replace user edits without approval.

Render approved revisions into static artifacts that require no dashboard, GitHub
or tenant application call at page-load time. Publish atomically and retain the
last good revision. Portfolio publication and user-confirmed demo readiness are
separate from process health. Portfolio pages and external case studies use no
live-compute project slot. No templates, renderer, storage or publish job exists yet.
