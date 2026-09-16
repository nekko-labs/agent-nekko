import pandas as pd
from datasets import Dataset
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM
import torch

# --- Configuration ---
MODEL_CHECKPOINT = "Helsinki-NLP/opus-mt-en-ja" # Example model for English to Japanese
MAX_LENGTH = 128
BATCH_SIZE = 32

def load_and_prepare_data(csv_path: str):
    """Loads data from CSV, tokenizes it, and creates a Hugging Face Dataset."""
    print("Loading data...")
    try:
        # Assuming the corpus is structured with 'English Sentence' and 'Japanese Translation' columns
        df = pd.read_csv(csv_path)
    except FileNotFoundError:
        print(f"Error: Corpus file not found at {csv_path}. Using dummy data.")
        data = {
            'English Sentence': ["Hello world", "How are you?", "This is a test."],
            'Japanese Translation': ["こんにちは世界", "お元気ですか？", "これはテストです。"]
        }
        df = pd.DataFrame(data)

    # Convert to Hugging Face Dataset format
    dataset = Dataset.from_pandas(df)
    return dataset

def tokenize_data(dataset: Dataset, tokenizer):
    """Tokenizes the source and target texts."""
    print("Tokenizing data...")
    
    def encode_example(examples):
        # Tokenize English (Source)
        source_tokens = tokenizer(examples["English Sentence"], max_length=MAX_LENGTH, truncation=True, padding="max_length")['input_ids']
        # Tokenize Japanese (Target)
        target_tokens = tokenizer(examples["Japanese Translation"], max_length=MAX_LENGTH, truncation=True, padding="max_length")['input_ids']
        return {"input_ids": source_tokens, "labels": target_tokens}

    tokenized_dataset = dataset.map(encode_example, batched=True)
    
    # Select only the necessary token IDs and remove original text columns
    tokenized_dataset = tokenized_dataset.remove_columns(["English Sentence", "Japanese Translation"])
    return tokenized_dataset

def setup_data_pipeline(csv_path: str):
    """Main function to run data loading, tokenization, and save the processed dataset."""
    # 1. Load Data
    raw_dataset = load_and_prepare_data(csv_path)
    
    # 2. Initialize Tokenizer
    tokenizer = AutoTokenizer.from_pretrained(MODEL_CHECKPOINT)
    
    # 3. Tokenize and Prepare
    tokenized_dataset = tokenize_data(raw_dataset, tokenizer)
    
    # 4. Save the processed dataset (for reproducibility)
    output_path = "nekko-training/japanese_translation/processed_dataset"
    print(f"Saving tokenized dataset to {output_path}")
    tokenized_dataset.save_to_disk(output_path)

if __name__ == "__main__":
    # NOTE: This assumes 'corpus.csv' is available in the parent directory of this script 
    # or that we are running from a location where the path works.
    CORPUS_PATH = "nekko-training/japanese_translation/data/corpus.csv"
    setup_data_pipeline(CORPUS_PATH)