import torch
from datasets import load_from_disk
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer, Seq2SeqTrainingArguments, Seq2SeqTrainer
import numpy as np
import evaluate

# --- Configuration ---
MODEL_CHECKPOINT = "Helsinki-NLP/opus-mt-en-ja" 
DATASET_PATH = "nekko-training/japanese_translation/processed_dataset"
OUTPUT_DIR = "nekko-training/japanese_translation/model_output"

def train_model():
    """Loads tokenized data, initializes the model, and trains it."""
    print("--- Starting Model Training ---")
    
    # 1. Load Data
    try:
        tokenized_dataset = load_from_disk(DATASET_PATH)
        print(f"Successfully loaded dataset from {DATASET_PATH}. Total samples: {len(tokenized_dataset)}")
    except Exception as e:
        print(f"Error loading dataset. Please ensure data_prep.py ran successfully. Error: {e}")
        return

    # 2. Load Tokenizer and Model
    tokenizer = AutoTokenizer.from_pretrained(MODEL_CHECKPOINT)
    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_CHECKPOINT)

    # 3. Define Metrics (BLEU is standard for MT)
    metric = evaluate.load("sacrebleu")

    def compute_metrics(eval_preds):
        """Computes BLEU score."""
        preds, labels = eval_preds
        # Decode predictions and labels
        decoded_preds = tokenizer.batch_decode(preds, skip_special_tokens=True)
        # Replace -100 (padding/ignored tokens) with the tokenizer's padding token ID for accurate decoding
        labels = np.where(labels != -100, labels, tokenizer.pad_token_id)
        decoded_labels = tokenizer.batch_decode(labels, skip_special_tokens=True)

        # Compute BLEU score
        bleu = metric.compute(predictions=decoded_preds, references=decoded_labels)
        return {"bleu": bleu["score"]}

    # 4. Training Arguments and Trainer Setup
    training_args = Seq2SeqTrainingArguments(
        output_dir=OUTPUT_DIR,
        evaluation_strategy="epoch",
        save_strategy="epoch",
        per_device_train_batch_size=16,
        per_device_eval_batch_size=16,
        num_train_epochs=3, # Small number for quick experiment
        weight_decay=0.01,
        save_total_limit=2,
        predict_with_generate=True,
        logging_dir='./logs',
        report_to=["none"] # Disable wandb/tensorboard logging for simplicity
    )

    trainer = Seq2SeqTrainer(
        model=model,
        args=training_args,
        train_dataset=tokenized_dataset, # Using the whole set as train/eval for this initial run
        tokenizer=tokenizer,
        compute_metrics=compute_metrics,
        # Data collator is implicitly handled by Seq2SeqTrainer when using Hugging Face datasets
    )

    print("Starting training...")
    trainer.train()
    
    # 5. Save Final Model and Tokenizer
    model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    print(f"Model successfully saved to {OUTPUT_DIR}")

if __name__ == "__main__":
    train_model()