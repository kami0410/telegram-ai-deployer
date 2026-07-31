# Disclaimer

This document is important but is not legal advice. Laws and platform rules vary by location and use case. Obtain advice from a qualified professional before public, commercial, regulated, or high-risk deployment.

## Independent project

This is an independent open-source project. It is not affiliated with, authorized by, sponsored by, endorsed by, or operated in partnership with Cloudflare, Telegram, DeepSeek, or any other third-party provider. Names and trademarks identify compatible services only and remain the property of their respective owners.

## Scope of use and experimental nature

The tool is designed for private, personal, text-only bots and is provided as an experimental utility. It is not intended for safety-critical, production-critical, emergency, medical, legal, financial, or regulatory environments. The project may change, break, or be discontinued at any time without notice, and updates may change how generated bots behave. Test each update on disposable resources before relying on it.

## Third-party services, terms, and charges

The tool calls third-party services in the user's own accounts. Users must review and comply with all applicable terms, privacy notices, acceptable-use rules, age and regional restrictions, rate limits, and billing policies. APIs, models, prices, quotas, and availability may change or end without notice. The maintainers do not control those services and do not pay the user's charges.

Prompts, conversations, and other data sent to model providers may be processed by those providers under their own policies. Review provider documentation for data retention, logging, and training-related settings before use.

## Data you create and store

Generated bots store conversations, summaries, long-term memories, reminders, and usage records in the user's own Cloudflare account (D1, Queues, Vectorize, and related resources). This data is transmitted to Telegram and to the configured AI provider as part of normal operation. Users are responsible for deciding what data to keep, configuring retention and access controls, maintaining backups, and deleting data when no longer needed. Deletion must be verified, because cached copies, dead-letter queues, vector indexes, and provider-side processing may retain data independently.

## Credentials and cloud changes

Users are responsible for lawfully obtaining, protecting, rotating, and revoking credentials, and for enabling available account protections such as multi-factor authentication. Deployment creates or changes cloud resources, databases, queues, vector indexes, workflows, secrets, Workers, scheduled jobs, and Telegram webhooks. Review the confirmation screen, target account, resource list, and likely cost before continuing. Users remain responsible for backups, deletion, billing, monitoring, incident response, and cleanup.

## Privacy, consent, and real-person material

Users determine what data is imported and processed. Do not import personal data, private conversations, likeness, voice, writing style, or a real person's persona unless there is valid authorization or another lawful basis. Respect applicable access, correction, deletion, objection, and withdrawal requests. Do not collect or process sensitive categories of personal data, or data about minors, without a lawful basis and appropriate safeguards. Do not use the tool to impersonate, deceive, harass, monitor, stalk, manipulate, or misrepresent another person. Complying with applicable privacy and data-protection law is the user's responsibility.

## Automated messages and content responsibility

Generated bots may send messages automatically, including proactive contacts, reminders, weekly reviews, and scheduled content, without case-by-case human review. Users are responsible for the content, tone, and compliance of those messages, including applicable anti-spam, consumer-protection, impersonation, and platform rules. Configure limits and review behavior regularly, and disable or remove the bot if it behaves unexpectedly.

## AI limitations

AI output may be inaccurate, fabricated, biased, offensive, unsafe, incomplete, or outdated. It may not reflect the imported material or the intent of any real person. It cannot speak for a real person, provide their consent, make commitments for them, or act as an emergency contact. Output is not medical, legal, financial, mental-health, safety, or other professional advice, and must not be used for safety-critical decisions. Use qualified professionals and emergency services where appropriate. Model availability and response quality are outside the maintainers' control.

## Security and data loss

No software or cloud service is perfectly secure or continuously available. Credentials can be exposed through a compromised device, account, dependency, extension, log, screenshot, or user action. Data may be corrupted, deleted, duplicated, delayed, or made unavailable. Maintain independent backups and test recovery and deletion procedures before relying on the system.

## No warranty

To the maximum extent permitted by applicable law, the software and documentation are provided "as is" and "as available", without warranties or conditions of any kind, express, implied, or statutory, including merchantability, fitness for a particular purpose, title, non-infringement, security, accuracy, availability, or freedom from defects.

## Limitation of liability

To the maximum extent permitted by applicable law, maintainers and contributors are not liable for direct, indirect, incidental, special, consequential, exemplary, or punitive loss arising from use or inability to use the project, including loss of data, credentials, revenue, reputation, opportunity, or access, and charges or claims involving third parties. Nothing here excludes rights or liabilities that applicable law does not permit parties to exclude.

## Intellectual property

The MIT License covers only this project's code. It grants no rights to third-party services, models, trademarks, datasets, imported prompts, conversations, identities, or other user-provided material. Users must have the rights needed to import or deploy any persona, likeness, or content they provide.

## Changes, maintenance, and support

The project is maintained on a best-effort basis with no service-level commitment, support guarantee, or liability for response times. Releases may change behavior or remove features. Users should pin the version they rely on, read release notes, and test upgrades before deployment.

## Export and regulatory compliance

Users are responsible for complying with applicable export-control, sanctions, and platform rules in their jurisdiction when downloading, distributing, or deploying the tool or generated bots.

## Security reports

Use the repository's private vulnerability-reporting channel described in SECURITY.md. Do not place tokens, account details, private prompts, conversations, or identifying information in public issues.

## Language

The English and Chinese versions are intended to express the same core meaning. English is the maintenance reference if a translation differs. Local law may require different wording or additional disclosures.
