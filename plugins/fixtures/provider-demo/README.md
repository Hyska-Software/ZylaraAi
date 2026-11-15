# Acme Gateway (fixture)

Declarative provider fixture. Installing it adds a namespaced provider
(`plugin__com_acme_gateway__gateway`) to the model picker. Configure the API key
in Settings → Providers; `https://api.acme.example` is a placeholder and will
not answer.

It is useful for UI/provider plumbing tests without a proprietary protocol.
