"""This type stub file was generated by pyright."""

DOCKER_CONFIG_FILENAME = ...
LEGACY_DOCKER_CONFIG_FILENAME = ...
log = ...

def find_config_file(config_path=...): ...
def config_path_from_environment(): ...
def home_dir():  # -> str:
    """Get the user's home directory, using the same logic as the Docker Engine
    client - use %USERPROFILE% on Windows, $HOME/getuid on POSIX.
    """
    ...

def load_general_config(config_path=...): ...